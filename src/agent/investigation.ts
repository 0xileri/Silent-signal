// A funded investigation: source-tracer → (free) evidence fetch → cross-checker → verifier, then a
// deterministic acceptance check, the real balance after, the alert and a fresh key.
//
// Money rules: the coordinator allocated a maximum; every call must fit its worst case inside what
// is left of it; every paid call is recorded the moment it returns, with the balance around it; a
// call costing more than the anomaly limit revokes the key on the spot.
import { randomBytes } from 'node:crypto'
import { MODELS, POLICY } from '../config.js'
import { log } from '../core/log.js'
import { lastBalance, save, state, type BalanceReading } from '../core/state.js'
import type { Artifact, Check, Decision, EvidenceDoc, Investigation, SignalCluster, SourceItem, SpendEvent, WorkerId, WorkerRun } from '../core/types.js'
import { BudgetError, KeyRejectedError, meteredCall, priceOf, round6, tokensIn, usdOf, type Meter } from '../orbio/gateway.js'
import type { HeldKey } from '../orbio/keys.js'
import { sendAlert } from './alert.js'
import { budgetLimits } from './budget-policy.js'
import { gatherEvidence } from './evidence.js'
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

/** The worst case of each planned call, at the gateway's real prices: the workers' "bids". */
export async function planCost(cluster: SignalCluster): Promise<{ total: number; perWorker: Record<WorkerId, number> }> {
  const posts = postsOf(cluster)
  const [worker, verifier] = await Promise.all([priceOf(MODELS.worker), priceOf(MODELS.verifier)])
  const tracerIn = tokensIn(TRACER_SYSTEM + tracerPrompt(cluster.representativeClaim, posts))
  const checkerIn = tokensIn(CHECKER_SYSTEM) + tokensIn('x'.repeat(EVIDENCE_CHARS_PLANNED)) + 300
  const verifierIn =
    tokensIn(VERIFIER_SYSTEM + verifierPrompt({ claim: cluster.representativeClaim, trigger: '', posts, docs: [], tracer: null, checker: null })) +
    MAX_TOKENS['source-tracer'] + MAX_TOKENS['cross-checker'] + 300
  const perWorker = {
    'source-tracer': round6(usdOf(worker, tracerIn, MAX_TOKENS['source-tracer'])),
    'cross-checker': round6(usdOf(worker, checkerIn, MAX_TOKENS['cross-checker'])),
    verifier: round6(usdOf(verifier, verifierIn, MAX_TOKENS.verifier)),
  }
  return { total: round6(Object.values(perWorker).reduce((a, b) => a + b, 0)), perWorker }
}

export async function runInvestigation(cluster: SignalCluster, decision: Decision, deps: InvestigationDeps): Promise<Investigation> {
  const posts = postsOf(cluster)
  const plan = await planCost(cluster)
  const worker = (id: WorkerId, role: string, model: string): WorkerRun => ({
    id, role, model, status: 'waiting', estimateUsd: plan.perWorker[id], costUsd: 0, startedAt: null, finishedAt: null, output: null, error: null,
  })
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
    workers: [
      worker('source-tracer', 'traces the origin and splits the narrative into sub-claims', MODELS.worker),
      worker('cross-checker', 'checks each sub-claim against official sources and linked pages', MODELS.worker),
      worker('verifier', 'combines both reports into a calibrated finding', MODELS.verifier),
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
    log('WORKER', `${run.id} started on ${run.model}: ${run.role} (bid ${usd(run.estimateUsd)}, ${usd(meter.limitUsd - meter.spentUsd)} left)`)
    for (let attempt = 0; ; attempt++) {
      const key = deps.getKey()
      if (!key) throw new Abort('no key: paid work stopped (key revoked)')
      let spend: SpendEvent | null = null
      try {
        const result = await meteredCall({
          key, model: run.model, system, user, schemaName, schema, maxTokens: MAX_TOKENS[run.id], meter, parse,
          onSpend: (s) => {
            spend = {
              id: `sp_${randomBytes(3).toString('hex')}`,
              at: new Date().toISOString(),
              investigationId: inv.id,
              workerId: run.id,
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
            inv.spentUsd = meter.spentUsd
            save()
          },
        })
        run.status = 'done'
        run.output = result.data
        return result.data
      } catch (err) {
        if (err instanceof BudgetError) {
          run.status = 'skipped'
          run.error = err.message
          log('BUDGET', `${run.id} not started: ${err.message}`)
          return null
        }
        if (err instanceof KeyRejectedError && attempt === 0 && (await deps.reclaimKey(`gateway rejected ${key.prefix}… during ${run.id}`))) continue
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

    inv.evidence = await gatherEvidence(posts)
    const fetched = inv.evidence.filter((d) => d.ok)
    log('WORKER', `cross-checker fetched ${fetched.length}/${inv.evidence.length} documents over HTTP ($0): ${inv.evidence.map((d) => `${d.ref} ${d.ok ? d.name : `failed (${d.error})`}`).join(' · ')}`)
    const subclaims = tracer?.subclaims.map((s) => s.claim) ?? [inv.claim]
    const checker = await work(checkerRun, 'cross_check', CHECKER_SYSTEM, checkerPrompt(subclaims, inv.evidence), CHECKER_SCHEMA, (v) => CheckerOutput.parse(v))
    if (checker) {
      const stances = ['supports', 'contradicts', 'context'].map((s) => `${checker.evidence.filter((e) => e.stance === s).length} ${s}`)
      log('WORKER', `cross-checker done: ${stances.join(', ')}; ${checker.gaps.length} gaps`)
    }

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
    if (!verdict) throw new Abort('the verifier did not report')
    inv.artifact = toArtifact(verdict, posts, inv.evidence)
    inv.acceptance = accept(verdict, posts, inv.evidence)
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
