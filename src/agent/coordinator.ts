// The coordinator: owns the mission, the key and the budget. It has the watcher read and cluster
// for free, scores every cluster that moved, decides IGNORE / WATCH / INVESTIGATE with the budget
// in view, and funds at most one investigation at a time.
//
// State machine: IDLE → SCANNING → EVALUATING → (WATCHING | FUNDING → INVESTIGATING → VERIFYING →
// ACCEPTED | REJECTED → ALERTED) → IDLE
import { MISSION, MODELS, POLICY, SCHEDULE, SIGNAL } from '../config.js'
import { log, recentLog } from '../core/log.js'
import { lastBalance, missionSpentUsd, save, state, type BalanceReading } from '../core/state.js'
import type { Decision, SignalCluster } from '../core/types.js'
import { DEMO_POSTS, DEMO_SOURCES, fixtureRun, releaseWave, startFixtureRun } from '../demo/fixture.js'
import { createKey, getBalance, getKeyStatus, keyAnswers, revokeKey as orbioRevoke, type HeldKey } from '../orbio/keys.js'
import { budgetLimits, decide } from './budget-policy.js'
import { planCost, postsOf, runInvestigation } from './investigation.js'
import { assignToCluster } from '../watcher/cluster.js'
import { claimText, embed } from '../watcher/embed.js'
import { measure } from '../watcher/score.js'
import { fetchAll, type FetchReport } from '../watcher/sources.js'

export type Phase =
  | 'STARTING' | 'IDLE' | 'SCANNING' | 'EVALUATING' | 'WATCHING' | 'FUNDING' | 'INVESTIGATING' | 'VERIFYING' | 'ACCEPTED' | 'REJECTED' | 'ALERTED'
export type KeyState = 'none' | 'active' | 'revoked' | 'retired'

const KEY_LABEL = 'silent-signal-agent'

const runtime = {
  phase: 'STARTING' as Phase,
  phaseAt: new Date().toISOString(),
  key: null as HeldKey | null,
  keyState: 'none' as KeyState,
  orbio: { connected: false, error: null as string | null },
  sources: [] as FetchReport[],
  scanning: false,
  investigating: null as string | null,
  demo: { running: false, wave: 0, lastStartedAt: 0 },
}

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function setPhase(phase: Phase): void {
  runtime.phase = phase
  runtime.phaseAt = new Date().toISOString()
}

async function readBalance(note: string): Promise<BalanceReading> {
  const b = await getBalance()
  const reading: BalanceReading = { at: b.at, balanceUsd: b.balanceUsd, spentUsd: b.spentUsd, accruedUsd: b.accruedUsd, note }
  state.agent.balances.push(reading)
  runtime.orbio.connected = true
  runtime.orbio.error = null
  save()
  return reading
}

// ── key lifecycle ───────────────────────────────────────────────────────────────────────────────

function keyEvent(event: 'claim' | 'rotate' | 'revoke' | 'retired', prefix: string | null, detail: string): void {
  state.agent.keyEvents.push({ at: new Date().toISOString(), event, prefix, detail })
  save()
}

export async function claimKey(reason: string): Promise<HeldKey> {
  const { key, replaced } = await createKey(KEY_LABEL)
  runtime.key = key
  runtime.keyState = 'active'
  state.agent.keyRevokedHold = false
  keyEvent('claim', key.prefix, reason)
  log('KEY', `orbio_create_key → claimed ${key.prefix}… (${reason})${replaced ? '; Orbio retired the account’s previous key in the same call' : ''}`)
  return key
}

/** Mint a new key (Orbio retires the old one in the same call), then prove it for free. */
export async function rotateKey(reason: string): Promise<void> {
  const old = runtime.key
  if (!old) {
    await claimKey(reason)
    return
  }
  const before = await readBalance('before rotation')
  const { key, replaced } = await createKey(KEY_LABEL)
  runtime.key = key
  runtime.keyState = 'active'
  const [oldCheck, newCheck] = await Promise.all([keyAnswers(old), keyAnswers(key)])
  const after = await readBalance('after rotation')
  keyEvent('rotate', key.prefix, `${reason}; old ${old.prefix}… → HTTP ${oldCheck.status}`)
  log(
    'KEY',
    `rotated ${old.prefix}… → ${key.prefix}… (${reason})${replaced ? '' : ' [Orbio reported no key to replace]'} · old key → HTTP ${oldCheck.status} ${oldCheck.ok ? 'STILL ANSWERS' : '(dead)'} · new key → HTTP ${newCheck.status} · balance ${before.balanceUsd.toFixed(6)} → ${after.balanceUsd.toFixed(6)} (${before.balanceUsd === after.balanceUsd ? 'credit unchanged' : 'changed'})`,
  )
}

/** `hold`: the agent stays keyless, across restarts too, until the operator claims a key again. */
export async function revokeAgentKey(reason: string, { hold = true } = {}): Promise<void> {
  const old = runtime.key
  const revoked = await orbioRevoke()
  runtime.key = null
  runtime.keyState = 'revoked'
  if (hold) state.agent.keyRevokedHold = true
  keyEvent('revoke', old?.prefix ?? null, reason)
  log('KEY', `orbio_revoke_key → ${revoked ? 'revoked' : 'there was no key to revoke'} (${reason}).${hold ? ' Paid work is disabled until the operator claims a key.' : ''}`)
  if (old) {
    const check = await keyAnswers(old)
    log('KEY', `revoked key ${old.prefix}… → HTTP ${check.status} ${check.ok ? 'STILL ANSWERS' : '(dead)'}`)
  }
  const status = await getKeyStatus()
  log('KEY', `orbio_get_key_status → ${status.hasKey ? `a key exists (${status.prefix}…)` : 'no key on the account'}`)
}

/** The gateway refused our key mid-investigation: someone else minted one on this account. */
async function reclaimKey(reason: string): Promise<HeldKey | null> {
  if (runtime.keyState !== 'active') return null
  runtime.keyState = 'retired'
  keyEvent('retired', runtime.key?.prefix ?? null, reason)
  log('KEY', `${reason}: the key was retired outside the agent; claiming a fresh one`)
  return claimKey('replacing a key retired elsewhere')
}

// ── start ───────────────────────────────────────────────────────────────────────────────────────

export async function startAgent(): Promise<void> {
  const limits = budgetLimits(missionSpentUsd())
  log(
    'AGENT',
    `mission: ${MISSION.statement} · budget ${usd(POLICY.budgetUsd)} (${usd(limits.remaining)} left) · reserve ${POLICY.reserveShare * 100}% · max ${POLICY.maxPerInvestigationShare * 100}% per investigation`,
  )
  try {
    const b = await readBalance('agent start')
    state.agent.startedAt = b.at
    state.agent.startBalanceUsd = b.balanceUsd
    log('BALANCE', `orbio_get_balance → ${b.balanceUsd.toFixed(6)} spendable (accrued ${b.accruedUsd.toFixed(6)}, spent ${b.spentUsd.toFixed(6)})`)
    if (state.agent.keyRevokedHold) {
      runtime.keyState = 'revoked'
      log('KEY', 'the key stays revoked (operator or anomaly revoke): no key is claimed until the operator presses Claim')
    } else if (!state.agent.paused) {
      await claimKey('agent start')
    }
    const status = await getKeyStatus()
    log('KEY', `orbio_get_key_status → ${status.hasKey ? `${status.prefix}… active, created ${status.createdAt}` : 'no key'}`)
  } catch (err) {
    runtime.orbio.error = err instanceof Error ? err.message : String(err)
    log('ERROR', `Orbio unavailable: ${runtime.orbio.error}. The watcher still runs for free; paid work is disabled.`)
  }
  save()
  setPhase('IDLE')
}

// ── scan → evaluate → fund ─────────────────────────────────────────────────────────────────────

let scanQueue: Promise<unknown> = Promise.resolve()

/** Scans run one at a time, in order. */
export function scan(reason: string): Promise<void> {
  const next = scanQueue.then(() => scanOnce(reason))
  scanQueue = next.catch(() => {})
  return next
}

async function scanOnce(reason: string): Promise<void> {
  runtime.scanning = true
  setPhase('SCANNING')
  try {
    const { items: raw, reports } = await fetchAll()
    runtime.sources = reports
    const fresh = raw.filter((r) => !state.items.has(r.id))
    const vectors = await embed(fresh.map(claimText))
    const touched = new Set<SignalCluster>()
    fresh.forEach((r, i) => {
      const item = { ...r, embedding: vectors[i]! }
      state.items.set(item.id, item)
      touched.add(assignToCluster(item, state.clusters, state.items))
    })
    prune()
    state.agent.scans++
    state.agent.lastScanAt = new Date().toISOString()
    state.agent.itemsRead += fresh.length
    const failed = reports.filter((r) => !r.ok)
    log(
      'WATCHER',
      `${reason}: ${raw.length} items from ${reports.length - failed.length}/${reports.length} sources, ${fresh.length} new, embedded locally ($0)` +
        (failed.length ? ` · failed: ${failed.map((f) => `${f.source.name} (${f.error})`).join(', ')}` : ''),
    )

    // Clusters that moved, plus on-mission ones still waiting on a decision (a key may be back).
    for (const c of state.clusters) if (c.state === 'watching') touched.add(c)

    setPhase('EVALUATING')
    let balanceUsd = lastBalance()?.balanceUsd ?? null
    if (runtime.orbio.connected || !runtime.orbio.error) {
      balanceUsd = await readBalance(`scan: ${reason}`).then((b) => b.balanceUsd, () => balanceUsd)
      // The account has one key. If something else minted or revoked it, ours is dead: take it back.
      const held = runtime.key
      const status = held ? await getKeyStatus().catch(() => null) : null
      if (held && status && status.prefix !== held.prefix) {
        await reclaimKey(`orbio_get_key_status shows ${status.hasKey ? `${status.prefix}…` : 'no key'}, not ${held.prefix}…`).catch((err) =>
          log('ERROR', `could not reclaim the key: ${err instanceof Error ? err.message : String(err)}`),
        )
      }
    }
    const decisions: { cluster: SignalCluster; decision: Decision }[] = []
    for (const cluster of touched) {
      if (cluster.state === 'archived') continue
      decisions.push({ cluster, decision: await evaluate(cluster, balanceUsd) })
    }

    const off = decisions.filter((d) => !d.decision.metrics.onMission).sort((a, b) => b.decision.score - a.decision.score)
    if (off.length) {
      const top = off[0]!
      log('SIGNAL', `${off.length} cluster(s) off mission → IGNORE, $0 (highest: ${top.decision.score.toFixed(2)}, ${top.decision.metrics.mentions} mentions: "${top.cluster.representativeClaim.slice(0, 70)}")`)
    }
    for (const { cluster, decision } of decisions.filter((d) => d.decision.metrics.onMission)) {
      const m = decision.metrics
      log(
        'SIGNAL',
        `${cluster.id} "${cluster.representativeClaim.slice(0, 80)}" · ${m.mentions} mentions · ${m.uniqueSources} sources · ${m.last15} in ${SIGNAL.windowMin}m · score ${decision.score.toFixed(2)} → ${decision.action}`,
        { clusterId: cluster.id },
      )
      log('COORDINATOR', decision.reason + (decision.action === 'INVESTIGATE' ? ` · allocating up to ${usd(decision.budgetUsd)}` : ''), { clusterId: cluster.id })
    }

    const fund = decisions.filter((d) => d.decision.action === 'INVESTIGATE').sort((a, b) => b.decision.score - a.decision.score)[0]
    if (fund) {
      runtime.investigating = fund.cluster.id
      try {
        await runInvestigation(fund.cluster, fund.decision, {
          getKey: () => runtime.key,
          reclaimKey,
          revokeKey: revokeAgentKey,
          rotateKey,
          readBalance,
          setPhase,
        })
      } finally {
        runtime.investigating = null
      }
    } else if (decisions.some((d) => d.decision.action === 'WATCH')) {
      setPhase('WATCHING')
    }
  } catch (err) {
    log('ERROR', `scan failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    runtime.scanning = false
    save()
    // Let the end state show for a moment before going back to idle.
    const settled = runtime.phase
    setTimeout(() => {
      if (runtime.phase === settled && !runtime.scanning) setPhase('IDLE')
    }, 8000)
  }
}

async function evaluate(cluster: SignalCluster, balanceUsd: number | null): Promise<Decision> {
  const { metrics, factors, score } = measure(cluster, state.items, state.clusters)
  const estimateUsd = metrics.onMission && score >= SIGNAL.investigateAt ? await planCost(cluster).then((p) => p.total, () => null) : null
  const result = decide({
    cluster,
    score,
    metrics,
    estimateUsd,
    missionSpentUsd: missionSpentUsd(),
    balanceUsd,
    keyPrefix: runtime.key?.prefix ?? null,
    keyState: runtime.keyState,
    paused: state.agent.paused,
    investigationRunning: runtime.investigating !== null,
  })
  const decision: Decision = {
    at: new Date().toISOString(),
    score,
    factors,
    metrics,
    action: result.action,
    reason: result.reason,
    checks: result.checks,
    estimateUsd,
    budgetUsd: result.budgetUsd,
    investigationId: null,
  }
  cluster.decisions.push(decision)
  if (cluster.decisions.length > 20) cluster.decisions.splice(0, cluster.decisions.length - 20)
  if (cluster.state !== 'resolved' && cluster.state !== 'investigating') {
    cluster.state = result.action === 'IGNORE' ? 'ignored' : 'watching'
  }
  return decision
}

/** Real-feed items age out; a cluster left with no items goes too, unless it was investigated. */
function prune(): void {
  const oldest = Date.now() - SIGNAL.retainHours * 3_600_000
  for (const [id, item] of state.items) {
    if (!item.demo && Date.parse(item.publishedAt ?? item.fetchedAt) < oldest) state.items.delete(id)
  }
  state.clusters = state.clusters.filter((c) => {
    c.itemIds = c.itemIds.filter((id) => state.items.has(id))
    if (c.itemIds.length) return true
    if (c.investigationId) {
      c.state = 'archived'
      return true
    }
    return false
  })
}

// ── demo fixture ────────────────────────────────────────────────────────────────────────────────

export function demoCooldownLeft(): number {
  return Math.max(0, Math.ceil((runtime.demo.lastStartedAt + SCHEDULE.demoCooldownSec * 1000 - Date.now()) / 1000))
}

export async function runDemo(): Promise<void> {
  if (runtime.demo.running) throw new Error('the demo is already running')
  runtime.demo.running = true
  runtime.demo.lastStartedAt = Date.now()
  try {
    // A fresh run: earlier fixture posts and their clusters are archived, investigations kept.
    for (const c of state.clusters) if (c.demo) c.state = 'archived'
    for (const [id, item] of state.items) if (item.demo) state.items.delete(id)
    const run = startFixtureRun()
    log('DEMO', `fixture run ${run.runId}: planted posts about the fictional ${MISSION.entity}, released in 3 waves. Not organic.`)
    for (const wave of [1, 2, 3]) {
      runtime.demo.wave = wave
      const posts = releaseWave(wave)
      const where = [...new Set(posts.map((p) => DEMO_SOURCES.find((s) => s.id === p.source)!.name))]
      log('DEMO', `wave ${wave}: released ${posts.length} planted post${posts.length > 1 ? 's' : ''} on ${where.join(', ')}`)
      await scan(`demo wave ${wave}`)
      if (wave < 3) await sleep(SCHEDULE.demoWaveDelaySec * 1000)
    }
  } finally {
    runtime.demo.running = false
    runtime.demo.wave = 0
    save()
  }
}

// ── operator controls ───────────────────────────────────────────────────────────────────────────

export function setPaused(paused: boolean): void {
  state.agent.paused = paused
  save()
  log('AGENT', paused ? 'paused by the operator: no scheduled scans, no spending' : 'resumed by the operator')
}

export const holdsKey = () => runtime.key !== null

export const isBusy = () => ({ scanning: runtime.scanning, investigating: runtime.investigating, demo: runtime.demo.running })

// ── what the dashboard shows ────────────────────────────────────────────────────────────────────

export function snapshot() {
  const spent = missionSpentUsd()
  const limits = budgetLimits(spent)
  const lastInvestigations = state.investigations.slice(-10)
  const avgCost = lastInvestigations.filter((i) => i.spentUsd > 0).map((i) => i.spentUsd)
  const typical = avgCost.length ? avgCost.reduce((a, b) => a + b, 0) / avgCost.length : null
  const itemsOf = (c: SignalCluster) =>
    postsOf(c).map((i) => ({ id: i.id, source: i.sourceName, url: i.url, title: i.title, text: i.text.slice(0, 220), publishedAt: i.publishedAt ?? i.fetchedAt, demo: i.demo }))
  const view = (c: SignalCluster) => ({
    id: c.id,
    claim: c.representativeClaim,
    state: c.state,
    demo: c.demo,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    investigationId: c.investigationId,
    decisions: c.decisions,
    items: itemsOf(c),
  })
  const live = state.clusters.filter((c) => c.state !== 'archived')
  const onMission = live.filter((c) => c.decisions.at(-1)?.metrics.onMission).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const background = live
    .filter((c) => !c.decisions.at(-1)?.metrics.onMission && c.decisions.length)
    .sort((a, b) => (b.decisions.at(-1)?.score ?? 0) - (a.decisions.at(-1)?.score ?? 0))
    .slice(0, 6)
    .map((c) => ({ id: c.id, claim: c.representativeClaim, decision: c.decisions.at(-1)!, sources: [...new Set(itemsOf(c).map((i) => i.source))] }))
  return {
    mission: { ...MISSION },
    policy: { ...POLICY, ...limits, models: MODELS, signal: SIGNAL },
    schedule: { enabled: SCHEDULE.enabled, scanEveryMin: SCHEDULE.scanEveryMin, demoWaveDelaySec: SCHEDULE.demoWaveDelaySec },
    phase: runtime.phase,
    phaseAt: runtime.phaseAt,
    paused: state.agent.paused,
    busy: isBusy(),
    demo: { ...runtime.demo, cooldownLeft: demoCooldownLeft(), run: fixtureRun(), posts: DEMO_POSTS.length },
    orbio: runtime.orbio,
    key: {
      state: runtime.keyState,
      prefix: runtime.key?.prefix ?? null,
      claimedAt: runtime.key?.claimedAt ?? null,
      events: state.agent.keyEvents.slice(-12).reverse(),
    },
    balance: {
      start: state.agent.startBalanceUsd,
      startedAt: state.agent.startedAt,
      latest: lastBalance(),
      history: state.agent.balances.slice(-60).map((b) => ({ at: b.at, usd: b.balanceUsd })),
    },
    budget: {
      budgetUsd: POLICY.budgetUsd,
      spentUsd: spent,
      remainingUsd: limits.remaining,
      reserveUsd: limits.reserve,
      capUsd: limits.cap,
      availableUsd: limits.available,
      typicalInvestigationUsd: typical,
      runway: typical ? Math.floor((limits.remaining - limits.reserve) / typical) : null,
    },
    sources: runtime.sources.map((r) => ({ name: r.source.name, type: r.source.type, url: r.source.url, ok: r.ok, items: r.items, cached: r.cached, error: r.error, at: r.at })),
    stats: {
      scans: state.agent.scans,
      lastScanAt: state.agent.lastScanAt,
      itemsRead: state.agent.itemsRead,
      itemsHeld: state.items.size,
      clusters: live.length,
      investigations: state.investigations.length,
    },
    signals: onMission.slice(0, 8).map(view),
    background,
    investigations: lastInvestigations.reverse(),
    spend: state.spend.slice(-40).reverse(),
    log: recentLog(160).reverse(),
  }
}
