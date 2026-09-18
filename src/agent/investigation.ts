// A funded investigation: source-tracer → (free) evidence fetch → cross-checker → verifier, then a
// deterministic acceptance check, the real balance after, the alert and a fresh key.
//
// Money rules: the coordinator allocated a maximum; every call must fit its worst case inside what
// is left of it; every paid call is recorded the moment it returns, with the balance around it; a
// call costing more than the anomaly limit revokes the key on the spot.
import { randomBytes } from 'node:crypto'
import { POLICY } from '../config.js'
import { log } from '../core/log.js'
import { lastBalance, save, state, type BalanceReading } from '../core/state.js'
import type {
  Artifact, Auction, Bid, Check, Decision, EvidenceDoc, Investigation, SignalCluster, SourceItem, SpendEvent, WorkerId, WorkerRun,
} from '../core/types.js'
import { AnswerError, BudgetError, KeyRejectedError, meteredCall, round6, type Meter } from '../orbio/gateway.js'
import type { HeldKey } from '../orbio/keys.js'
import { sendAlert } from './alert.js'
import { budgetLimits } from './budget-policy.js'
import { gatherEvidence } from './evidence.js'
import { gradeChecker, gradeTracer, gradeVerifier, recordJob, runAuction, type Grade } from './market.js'
import {
  CHECKER_SCHEMA, CHECKER_SYSTEM, checkerPrompt, CheckerOutput, MAX_TOKENS, postRefs, TRACER_SCHEMA, TRACER_SYSTEM, tracerPrompt,
  TracerOutput, VERIFIER_SCHEMA, VERIFIER_SYSTEM, verifierPrompt, VerifierOutput,
} from './workers.js'

export interface InvestigationDeps {
  getKey: () => HeldKey | null
  /** The gateway refused the key (retired elsewhere): claim a fresh one if policy allows. */
  reclaimKey: (reason: string) => Promise<HeldKey | null>
  revokeKey: (reason: string) => Promise<void>
  rotateKey: (reason: string) => Promise<void>
  readBalance: (note: string) => Promise<BalanceReading>
  setPhase: (phase: 'FUNDING' | 'INVESTIGATING' | 'VERIFYING' | 'ACCEPTED' | 'REJECTED' | 'ALERTED') => void
}

class Abort extends Error {}

const usd = (n: number) => `$${n.toFixed(4)}`
const EVIDENCE_CHARS_PLANNED = 2 * 2500 + 2 * 2500

export function postsOf(cluster: SignalCluster): SourceItem[] {
  return cluster.itemIds
    .map((id) => state.items.get(id))
    .filter((i): i is SourceItem => !!i)
    .sort((a, b) => Date.parse(a.publishedAt ?? a.fetchedAt) - Date.parse(b.publishedAt ?? b.fetchedAt))
    .slice(0, 25)
}

const ROLES: WorkerId[] = ['source-tracer', 'cross-checker', 'verifier']

/**
 * The market for this job: one auction per role, priced on this cluster's actual prompt sizes.
 * `total` is the winners' worst case (full output caps), which is what the budget must cover.
 */
export async function planInvestigation(cluster: SignalCluster): Promise<{ total: number; auctions: Auction[] }> {
  const posts = postsOf(cluster)
  const chars: Record<WorkerId, number> = {
    'source-tracer': (TRACER_SYSTEM + tracerPrompt(cluster.representativeClaim, posts)).length,
    'cross-checker': CHECKER_SYSTEM.length + EVIDENCE_CHARS_PLANNED + 900,
    verifier:
      (VERIFIER_SYSTEM + verifierPrompt({ claim: cluster.representativeClaim, trigger: '', posts, docs: [], tracer: null, checker: null })).length +
      3 * (MAX_TOKENS['source-tracer'] + MAX_TOKENS['cross-checker'] + 300),
  }
  const auctions = await Promise.all(ROLES.map((role) => runAuction(role, chars[role], MAX_TOKENS[role])))
  const total = auctions.reduce((sum, a) => sum + a.bids.find((b) => b.bidder === a.winner)!.worstUsd, 0)
  return { total: round6(total), auctions }
}

export async function runInvestigation(cluster: SignalCluster, decision: Decision, deps: InvestigationDeps): Promise<Investigation> {
  const posts = postsOf(cluster)
  const plan = await planInvestigation(cluster)
  const worker = (id: WorkerId, role: string): WorkerRun => {
    const auction = plan.auctions.find((a) => a.role === id)!
    const win = auction.bids.find((b) => b.bidder === auction.winner)!
    return {
      id, role, bidder: win.bidder, label: win.label, model: win.model, status: 'waiting', estimateUsd: win.bidUsd, costUsd: 0,
      startedAt: null, finishedAt: null, output: null, error: null, completionTokens: 0, latencyMs: null, grade: null,
    }
  }
  const inv: Investigation = {
    id: `inv_${randomBytes(3).toString('hex')}`,
    clusterId: cluster.id,
    claim: cluster.representativeClaim,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    status: 'funded',
    maxBudgetUsd: round6(decision.budgetUsd),
    estimateUsd: plan.total,
    spentUsd: 0,
    balanceBefore: null,
    balanceAfter: null,
    keyPrefix: deps.getKey()?.prefix ?? null,
    contract: {
      task: `Verify the emerging claim: "${cluster.representativeClaim}"`,
      deadlineSec: POLICY.deadlineSec,
      successConditions: [
        'identify the earliest known source',
        'return at least 2 independent evidence items if available',
        'label each source as supports / contradicts / context',
        'state the material unknowns',
        'return the structured artifact, citing only real posts and fetched documents',
      ],
    },
    trigger: {
      score: decision.score,
      mentions: decision.metrics.mentions,
      uniqueSources: decision.metrics.uniqueSources,
      last15: decision.metrics.last15,
      prev15: decision.metrics.prev15,
    },
    auctions: plan.auctions,
    workers: [
      worker('source-tracer', 'traces the origin and splits the narrative into sub-claims'),
      worker('cross-checker', 'checks each sub-claim against official sources and linked pages'),
      worker('verifier', 'combines both reports into a calibrated finding'),
    ],
    evidence: [],
    artifact: null,
    acceptance: null,
    alert: null,
    error: null,
    demo: cluster.demo,
  }
  state.investigations.push(inv)
  cluster.investigationId = inv.id
  cluster.state = 'investigating'
  decision.investigationId = inv.id
  save()

  const limits = budgetLimits(state.spend.reduce((s, e) => s + e.costUsd, 0))
  deps.setPhase('FUNDING')
  log(
    'BUDGET',
    `approved ${inv.id}: up to ${usd(inv.maxBudgetUsd)} (worst case ${usd(plan.total)}); reserve ${usd(limits.reserve)} stays untouched`,
    { investigationId: inv.id },
  )
  for (const a of plan.auctions.filter((a) => a.role !== 'verifier')) {
    const [win, ...rest] = [...a.bids].sort((x, y) => (x.bidder === a.winner ? -1 : y.bidder === a.winner ? 1 : (y.utility ?? -1) - (x.utility ?? -1)))
    const bid = (b: Bid) => `${b.bidder} $${b.bidUsd.toFixed(4)} @ ${b.reputation.toFixed(2)}${b.eligible ? '' : ' (below floor)'}`
    log('MARKET', `${a.role} auction: ${bid(win!)} wins over ${rest.map(bid).join(', ')}; ${a.reason}`, { investigationId: inv.id })
  }
  const meter: Meter = { limitUsd: inv.maxBudgetUsd, spentUsd: 0 }
  const deadline = Date.now() + POLICY.deadlineSec * 1000

  async function work<T>(run: WorkerRun, schemaName: string, system: string, user: string, schema: Record<string, unknown>, parse: (v: unknown) => T): Promise<T | null> {
    if (Date.now() > deadline) {
      run.status = 'skipped'
      run.error = `deadline of ${POLICY.deadlineSec}s passed`
      log('WORKER', `${run.id} skipped: ${run.error}`)
      return null
    }
    run.status = 'running'
    run.startedAt = new Date().toISOString()
    save()
    log('WORKER', `${run.id} (${run.bidder}, ${run.label}) started: ${run.role} (bid ${usd(run.estimateUsd)}, ${usd(meter.limitUsd - meter.spentUsd)} left)`)
    let keyRetried = false
    let maxTokens: number = MAX_TOKENS[run.id]
    for (;;) {
      const key = deps.getKey()
      if (!key) throw new Abort('no key: paid work stopped (key revoked)')
      let spend: SpendEvent | null = null
      const t0 = Date.now()
      try {
        const result = await meteredCall({
          key, model: run.model, system, user, schemaName, schema, maxTokens, meter, parse,
          onSpend: (s) => {
            spend = {
              id: `sp_${randomBytes(3).toString('hex')}`,
              at: new Date().toISOString(),
              investigationId: inv.id,
              workerId: run.id,
              bidder: run.bidder,
              model: s.model,
              purpose: run.role,
              promptTokens: s.promptTokens,
              completionTokens: s.completionTokens,
              costUsd: s.costUsd,
              costSource: s.costSource,
              keyPrefix: key.prefix,
              balanceBefore: lastBalance()?.balanceUsd ?? null,
              balanceAfter: null,
            }
            state.spend.push(spend)
            run.costUsd = round6(run.costUsd + s.costUsd)
            run.completionTokens += s.completionTokens
            inv.spentUsd = meter.spentUsd
            save()
          },
        })
        run.status = 'done'
        run.output = result.data
        run.latencyMs = Date.now() - t0
        return result.data
      } catch (err) {
        if (err instanceof BudgetError) {
          run.status = 'skipped'
          run.error = err.message
          log('BUDGET', `${run.id} not started: ${err.message}`)
          return null
        }
        if (err instanceof KeyRejectedError && !keyRetried && (await deps.reclaimKey(`gateway rejected ${key.prefix}… during ${run.id}`))) {
          keyRetried = true
          continue
        }
        if (err instanceof AnswerError && !run.retried) {
          run.retried = true
          maxTokens = Math.round(maxTokens * 1.6)
          log('WORKER', `${run.id} (${run.bidder}): ${err.message}; retrying once with a ${maxTokens}-token cap`)
          continue
        }
        run.status = 'failed'
        run.error = err instanceof Error ? err.message : String(err)
        log('ERROR', `${run.id} failed: ${run.error}`)
        return null
      } finally {
        const s = spend as SpendEvent | null
        if (s) {
          const after = await deps.readBalance(`after ${run.id}`).catch(() => null)
          s.balanceAfter = after?.balanceUsd ?? null
          log(
            'SPEND',
            `${run.id} · ${s.model} · ${s.promptTokens}+${s.completionTokens} tokens · ${usd(s.costUsd)} (${s.costSource}) · balance ${s.balanceBefore?.toFixed(6) ?? '?'} → ${s.balanceAfter?.toFixed(6) ?? '?'}`,
            { investigationId: inv.id },
          )
          if (s.costUsd > POLICY.anomalyCallUsd) {
            await deps.revokeKey(`spend anomaly: one call cost ${usd(s.costUsd)}, limit ${usd(POLICY.anomalyCallUsd)}`)
            // eslint-disable-next-line no-unsafe-finally
            throw new Abort(`spend anomaly on ${run.id}; key revoked`)
          }
        }
        run.finishedAt = new Date().toISOString()
        save()
      }
    }
  }

  /** The code grades the job and the worker's reputation moves. Budget or deadline skips are not the worker's fault. */
  function review(run: WorkerRun, graded: Grade): void {
    if (run.status === 'skipped' || run.status === 'waiting') return
    const grade = run.retried && graded.quality > 0
      ? { quality: Math.round(graded.quality * 0.85 * 1000) / 1000, notes: [...graded.notes, 'needed a retry after a cut-off or off-schema answer'] }
      : graded
    const { before, after } = recordJob(run.bidder, inv.id, grade, {
      costUsd: run.costUsd,
      completionTokens: run.completionTokens,
      latencyMs: run.latencyMs ?? 0,
    })
    run.grade = { ...grade, reputationBefore: before, reputationAfter: after }
    save()
    log('MARKET', `${run.bidder} graded ${grade.quality.toFixed(2)} (${grade.notes.join('; ')}) · reputation ${before.toFixed(2)} → ${after.toFixed(2)}`, {
      investigationId: inv.id,
    })
  }

  let before: BalanceReading | null = null
  try {
    before = await deps.readBalance(`before ${inv.id}`)
    inv.balanceBefore = before.balanceUsd
    log('BALANCE', `before ${inv.id}: ${before.balanceUsd.toFixed(6)} (orbio_get_balance)`)
    inv.status = 'running'
    deps.setPhase('INVESTIGATING')

    const [tracerRun, checkerRun, verifierRun] = inv.workers as [WorkerRun, WorkerRun, WorkerRun]
    const tracer = await work(tracerRun, 'trace', TRACER_SYSTEM, tracerPrompt(inv.claim, posts), TRACER_SCHEMA, (v) => TracerOutput.parse(v))
    if (tracer) {
      log('WORKER', `source-tracer done: origin ${tracer.origin_ref}, ${tracer.subclaims.length} sub-claims, ${tracer.firsthand_sources} firsthand sources`)
    }
    review(tracerRun, gradeTracer(tracer, posts))

    inv.evidence = await gatherEvidence(posts)
    const fetched = inv.evidence.filter((d) => d.ok)
    log('WORKER', `cross-checker fetched ${fetched.length}/${inv.evidence.length} documents over HTTP ($0): ${inv.evidence.map((d) => `${d.ref} ${d.ok ? d.name : `failed (${d.error})`}`).join(' · ')}`)
    const subclaims = tracer?.subclaims.map((s) => s.claim) ?? [inv.claim]
    const checker = await work(checkerRun, 'cross_check', CHECKER_SYSTEM, checkerPrompt(subclaims, inv.evidence), CHECKER_SCHEMA, (v) => CheckerOutput.parse(v))
    if (checker) {
      const stances = ['supports', 'contradicts', 'context'].map((s) => `${checker.evidence.filter((e) => e.stance === s).length} ${s}`)
      log('WORKER', `cross-checker done: ${stances.join(', ')}; ${checker.gaps.length} gaps`)
    }
    review(checkerRun, gradeChecker(checker, inv.evidence, subclaims.length))

    inv.status = 'verifying'
    deps.setPhase('VERIFYING')
    const m = decision.metrics
    const trigger =
      `${m.mentions} mentions from ${m.uniqueSources} sources, ${m.last15} in the last 15 min, score ${decision.score.toFixed(2)}` +
      (m.severityTerms.length ? `; severity terms in the posts: ${m.severityTerms.slice(0, 8).join(', ')}` : '')
    const verdict = await work(
      verifierRun, 'verify', VERIFIER_SYSTEM,
      verifierPrompt({ claim: inv.claim, trigger, posts, docs: inv.evidence, tracer, checker }),
      VERIFIER_SCHEMA, (v) => VerifierOutput.parse(v),
    )
    if (!verdict) {
      review(verifierRun, gradeVerifier(null, []))
      throw new Abort('the verifier did not report')
    }
    inv.artifact = toArtifact(verdict, posts, inv.evidence)
    inv.acceptance = accept(verdict, posts, inv.evidence)
    review(verifierRun, gradeVerifier(verdict, inv.acceptance.checks))
    inv.status = inv.acceptance.accepted ? 'complete' : 'rejected'
    const label = `${verdict.status.replace('_', ' ').toUpperCase()} at ${Math.round(inv.artifact.confidence * 100)}%`
    if (inv.acceptance.accepted) log('VERIFIER', `accepted the artifact: ${label}, recommend ${verdict.recommended_action}`)
    else log('VERIFIER', `rejected the artifact (${label}): ${inv.acceptance.checks.filter((c) => !c.ok).map((c) => c.label).join(', ')}`)
    deps.setPhase(inv.acceptance.accepted ? 'ACCEPTED' : 'REJECTED')
  } catch (err) {
    inv.status = 'failed'
    inv.error = err instanceof Error ? err.message : String(err)
    log('ERROR', `${inv.id} stopped: ${inv.error}`)
  }

  // The real balance after. A spend shows up on the balance within a few seconds.
  if (before) {
    const after = await settle(deps, inv.id, before.balanceUsd, meter.spentUsd)
    if (after) {
      inv.balanceAfter = after.balanceUsd
      log('BALANCE', `after ${inv.id}: ${after.balanceUsd.toFixed(6)}`)
      log('SPEND', `${inv.id} total: metered ${usd(meter.spentUsd)} · balance moved ${usd(before.balanceUsd - after.balanceUsd)} · allocation was ${usd(inv.maxBudgetUsd)}`)
    }
  }
  cluster.state = 'resolved'
  inv.finishedAt = new Date().toISOString()
  save()

  if (inv.status === 'complete') {
    inv.alert = await sendAlert(inv)
    log('ALERT', `${inv.alert.channel}: ${inv.alert.detail}`)
    if (inv.alert.sent) deps.setPhase('ALERTED')
  }
  if (POLICY.rotateAfterInvestigation && deps.getKey()) {
    await deps.rotateKey(`policy: fresh key after every investigation (${inv.id})`).catch((err) => log('ERROR', `rotation failed: ${err.message}`))
  }
  save()
  return inv
}

async function settle(deps: InvestigationDeps, id: string, before: number, metered: number): Promise<BalanceReading | null> {
  let reading: BalanceReading | null = null
  for (let i = 0; i < 5; i++) {
    reading = await deps.readBalance(`after ${id}`).catch(() => reading)
    if (!reading || metered === 0 || before - reading.balanceUsd >= metered * 0.95) break
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  return reading
}

function toArtifact(v: VerifierOutput, posts: SourceItem[], docs: EvidenceDoc[]): Artifact {
  const refs = new Map<string, { url: string; source: string; at: string | null }>()
  for (const { ref, post } of postRefs(posts)) refs.set(ref, { url: post.url, source: post.sourceName, at: post.publishedAt ?? post.fetchedAt })
  for (const d of docs.filter((d) => d.ok)) refs.set(d.ref, { url: d.url, source: d.name, at: null })
  const line = (l: { ref: string; finding: string }) => ({ ref: l.ref, url: refs.get(l.ref)?.url ?? '', source: refs.get(l.ref)?.source ?? 'unknown ref', finding: l.finding })
  const origin = refs.get(v.origin_ref)
  return {
    claim: v.claim,
    status: v.status,
    confidence: Math.min(1, Math.max(0, v.confidence)),
    origin: { ref: v.origin_ref, url: origin?.url ?? '', source: origin?.source ?? 'unknown ref', firstSeen: origin?.at ?? null },
    finding: v.finding,
    evidenceFor: v.evidence_for.map(line),
    evidenceAgainst: v.evidence_against.map(line),
    unknowns: v.unknowns,
    recommendedAction: v.recommended_action,
    rationale: v.rationale,
  }
}

/** The acceptance check is code, not a model: the artifact must cite real things and admit what it doesn't know. */
function accept(v: VerifierOutput, posts: SourceItem[], docs: EvidenceDoc[]): { accepted: boolean; checks: Check[] } {
  const postRefSet = new Set(postRefs(posts).map((p) => p.ref))
  const docRefSet = new Set(docs.filter((d) => d.ok).map((d) => d.ref))
  const cited = [...v.evidence_for, ...v.evidence_against].map((l) => l.ref)
  const unknownRefs = cited.filter((r) => !postRefSet.has(r) && !docRefSet.has(r))
  const urlOf = (ref: string) => (docRefSet.has(ref) ? docs.find((d) => d.ref === ref)!.url : posts[Number(ref.slice(1)) - 1]?.url)
  const independent = new Set(cited.filter((r) => !unknownRefs.includes(r)).map(urlOf)).size
  const available = docRefSet.size + postRefSet.size
  const checks: Check[] = [
    { label: 'Fits the schema', ok: true, detail: 'parsed and validated' },
    { label: 'Origin is a real post', ok: postRefSet.has(v.origin_ref), detail: `origin ${v.origin_ref}` },
    { label: 'Every citation exists', ok: unknownRefs.length === 0, detail: unknownRefs.length ? `unknown refs: ${unknownRefs.join(', ')}` : `${cited.length} citations, all real` },
    {
      label: 'Two independent evidence items',
      ok: independent >= Math.min(2, available),
      detail: `${independent} distinct sources cited (${available} available)`,
    },
    {
      label: 'Uncertainty stated',
      ok: v.confidence < 1 && (v.unknowns.length > 0 || v.status === 'unclear'),
      detail: `confidence ${v.confidence}, ${v.unknowns.length} unknowns`,
    },
    {
      label: 'Status matches evidence',
      ok: v.status === 'unclear' || v.status === 'unsupported' ? true : v.evidence_for.length > 0,
      detail: `${v.status} with ${v.evidence_for.length} for / ${v.evidence_against.length} against`,
    },
    { label: 'Confidence in range', ok: v.confidence >= 0 && v.confidence <= 1, detail: String(v.confidence) },
  ]
  return { accepted: checks.every((c) => c.ok), checks }
}
