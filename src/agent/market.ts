// The worker market. Each investigation role has a pool of workers on different models; before an
// investigation is funded, every worker bids its expected cost for this job at the gateway's real
// prices, and the coordinator hires the best expected quality per dollar (spec: utility =
// expected_quality / estimated_cost) among workers whose reputation clears the quality floor.
//
// Reputation is earned, not claimed: after each job the code checks the work (did the tracer name
// the true earliest post? do the cross-checker's quotes appear word for word in the documents it
// cites?) and the score feeds the next auction. No worker is paid: bids are cost estimates, and
// every cent is the agent's own inference spend.
import { MODELS } from '../config.js'
import { save, state } from '../core/state.js'
import type { Auction, Bid, EvidenceDoc, SourceItem, WorkerId, WorkerRecord } from '../core/types.js'
import { priceOf, round6, tokensIn, usdOf } from '../orbio/gateway.js'
import type { CheckerOutput, TracerOutput, VerifierOutput } from './workers.js'

export type Role = WorkerId

export interface Bidder {
  id: string
  role: Role
  model: string
  label: string
}

/** The pools. The verifier is not auctioned: the judge should not be whoever bids lowest. */
export const BIDDERS: Bidder[] = [
  { id: 'tracer-haiku', role: 'source-tracer', model: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5' },
  { id: 'tracer-flash-lite', role: 'source-tracer', model: 'google/gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite' },
  { id: 'tracer-mistral', role: 'source-tracer', model: 'mistralai/mistral-small-3.2-24b-instruct', label: 'Mistral Small 3.2' },
  { id: 'checker-haiku', role: 'cross-checker', model: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5' },
  { id: 'checker-flash-lite', role: 'cross-checker', model: 'google/gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite' },
  { id: 'checker-mistral', role: 'cross-checker', model: 'mistralai/mistral-small-3.2-24b-instruct', label: 'Mistral Small 3.2' },
  { id: 'verifier-sonnet', role: 'verifier', model: MODELS.verifier, label: 'Claude Sonnet 5' },
]

/**
 * A newcomer starts at the prior, worth two jobs; the floor keeps proven-bad workers out. A worker
 * with no record gets one trial job if its bid is within `trialMaxMultiple` of the best-value bid,
 * so reputations get tested instead of the cheapest worker winning forever unexamined.
 */
export const MARKET = { priorQuality: 0.8, priorWeight: 2, qualityFloor: 0.75, trialMaxMultiple: 5 }

export const reputationStore = (): Record<string, WorkerRecord> => (state.agent.reputation ??= {})

export function reputationOf(id: string): { reputation: number; jobs: number; avgCostUsd: number | null; avgLatencyMs: number | null } {
  const r = reputationStore()[id]
  const jobs = r?.jobs ?? 0
  return {
    reputation: round3((MARKET.priorQuality * MARKET.priorWeight + (r?.qualitySum ?? 0)) / (MARKET.priorWeight + jobs)),
    jobs,
    avgCostUsd: jobs ? round6(r!.costSum / jobs) : null,
    avgLatencyMs: jobs ? Math.round(r!.latencyMsSum / jobs) : null,
  }
}

/**
 * One auction per role. `promptChars` is this job's prompt size for the role; a bid prices it at
 * the bidder's model, with the bidder's own average answer length (or 60% of the cap before it
 * has a record). The worst case, the full output cap, is what the budget check uses.
 */
export async function runAuction(role: Role, promptChars: number, maxTokens: number): Promise<Auction> {
  const pool = BIDDERS.filter((b) => b.role === role)
  const bids: Bid[] = []
  for (const b of pool) {
    const price = await priceOf(b.model)
    const r = reputationStore()[b.id]
    const expectedOut = r?.jobs ? Math.min(maxTokens, r.completionTokensSum / r.jobs) : maxTokens * 0.6
    const promptTokens = tokensIn('x'.repeat(promptChars))
    const rep = reputationOf(b.id)
    const bidUsd = round6(usdOf(price, promptTokens, expectedOut))
    const eligible = role === 'verifier' || rep.reputation >= MARKET.qualityFloor
    bids.push({
      bidder: b.id,
      label: b.label,
      model: b.model,
      bidUsd,
      worstUsd: round6(usdOf(price, promptTokens, maxTokens)),
      reputation: rep.reputation,
      jobs: rep.jobs,
      eligible,
      utility: eligible && bidUsd > 0 ? Math.round(rep.reputation / bidUsd) : null,
    })
  }
  const eligible = bids.filter((b) => b.eligible)
  const best = eligible.length
    ? eligible.reduce((a, b) => ((b.utility ?? 0) > (a.utility ?? 0) ? b : a))
    : bids.reduce((a, b) => (b.reputation > a.reputation ? b : a))
  const trial = eligible
    .filter((b) => b.jobs === 0 && b.bidder !== best.bidder && b.bidUsd <= best.bidUsd * MARKET.trialMaxMultiple)
    .sort((a, b) => (b.utility ?? 0) - (a.utility ?? 0))[0]
  const winner = role !== 'verifier' && trial ? trial : best
  const reason =
    role === 'verifier'
      ? 'the verifier is appointed, not auctioned'
      : winner === trial
        ? `trial job: ${trial.label} has no record yet and bids within ${MARKET.trialMaxMultiple}× of the best value (${best.label})`
        : eligible.length
          ? `best quality per dollar: reputation ${winner.reputation.toFixed(2)} for a $${winner.bidUsd.toFixed(4)} bid`
          : `no worker clears the ${MARKET.qualityFloor} quality floor; hiring the most reputable`
  return { role, bids, winner: winner.bidder, reason }
}

export function bidder(id: string): Bidder {
  const b = BIDDERS.find((x) => x.id === id)
  if (!b) throw new Error(`unknown worker ${id}`)
  return b
}

// ── quality checks: code, not a model, grades the work ──────────────────────────────────────────

export interface Grade {
  quality: number
  notes: string[]
}

const refNumber = (ref: string) => Number(ref.replace(/^[A-Z]/, ''))

/** Posts arrive oldest first as P1..Pn, so the true origin is P1. */
export function gradeTracer(out: TracerOutput | null, posts: SourceItem[]): Grade {
  if (!out) return { quality: 0, notes: ['no usable answer'] }
  const real = new Set(posts.map((_, i) => `P${i + 1}`))
  const cited = [out.origin_ref, ...out.subclaims.flatMap((s) => [s.first_ref, ...s.refs])]
  const valid = cited.filter((r) => real.has(r)).length / Math.max(1, cited.length)
  const originOk = out.origin_ref === 'P1' ? 1 : 0
  const ordered = out.subclaims.length
    ? out.subclaims.filter((s) => s.refs.includes(s.first_ref) && refNumber(s.first_ref) === Math.min(...s.refs.map(refNumber))).length /
      out.subclaims.length
    : 0
  const notes = [
    originOk ? 'named the true earliest post' : `named ${out.origin_ref} as the origin, not P1`,
    `${Math.round(valid * 100)}% of citations are real posts`,
    `${Math.round(ordered * 100)}% of sub-claims start where they first appear`,
  ]
  return { quality: round3(0.4 * originOk + 0.35 * valid + 0.25 * ordered), notes }
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[“”"‘’'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** A quote counts if it (or each part around an ellipsis) appears word for word in the cited document. */
function quoteFound(quote: string, doc: EvidenceDoc | undefined): boolean {
  if (!doc?.ok || !quote.trim()) return false
  const text = normalize(doc.excerpt)
  const parts = quote
    .split(/\.{3}|…/)
    .map(normalize)
    .filter((part) => part.length >= 8)
  return parts.length > 0 && parts.every((part) => text.includes(part))
}

export function gradeChecker(out: CheckerOutput | null, docs: EvidenceDoc[], subclaims: number): Grade {
  if (!out) return { quality: 0, notes: ['no usable answer'] }
  const byRef = new Map(docs.filter((d) => d.ok).map((d) => [d.ref, d]))
  const n = out.evidence.length
  if (!n) return { quality: byRef.size ? 0.2 : 0.6, notes: ['cited no evidence'] }
  const valid = out.evidence.filter((e) => byRef.has(e.ref)).length / n
  const verbatim = out.evidence.filter((e) => quoteFound(e.quote, byRef.get(e.ref))).length / n
  const coverage = Math.min(1, out.assessments.length / Math.max(1, subclaims))
  const notes = [
    `${Math.round(valid * 100)}% of citations are fetched documents`,
    `${Math.round(verbatim * 100)}% of quotes appear word for word`,
    `assessed ${out.assessments.length} of ${subclaims} sub-claims`,
  ]
  return { quality: round3(0.3 * valid + 0.5 * verbatim + 0.2 * coverage), notes }
}

export function gradeVerifier(out: VerifierOutput | null, checks: { ok: boolean }[]): Grade {
  if (!out) return { quality: 0, notes: ['no usable answer'] }
  const passed = checks.filter((c) => c.ok).length
  return { quality: round3(passed / Math.max(1, checks.length)), notes: [`${passed} of ${checks.length} acceptance checks passed`] }
}

/** Records a finished job and returns the worker's reputation before and after. */
export function recordJob(
  id: string,
  investigationId: string,
  grade: Grade,
  job: { costUsd: number; completionTokens: number; latencyMs: number },
): { before: number; after: number } {
  const before = reputationOf(id).reputation
  const store = reputationStore()
  const r = (store[id] ??= { jobs: 0, qualitySum: 0, costSum: 0, completionTokensSum: 0, latencyMsSum: 0, recent: [] })
  r.jobs++
  r.qualitySum += grade.quality
  r.costSum += job.costUsd
  r.completionTokensSum += job.completionTokens
  r.latencyMsSum += job.latencyMs
  r.recent.push({ at: new Date().toISOString(), investigationId, quality: grade.quality, notes: grade.notes })
  if (r.recent.length > 10) r.recent.splice(0, r.recent.length - 10)
  save()
  return { before, after: reputationOf(id).reputation }
}

export function marketView() {
  return BIDDERS.map((b) => ({ ...b, ...reputationOf(b.id), recent: reputationStore()[b.id]?.recent.at(-1) ?? null }))
}

const round3 = (n: number) => Math.round(n * 1000) / 1000
