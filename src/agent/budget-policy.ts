// The coordinator's decision: is this signal worth paying to investigate, and how much may the
// investigation spend? Every check is recorded with its numbers, so the dashboard can show exactly
// why the agent did or didn't spend.
import { MISSION, POLICY, SIGNAL } from '../config.js'
import { missionBudgetUsd } from '../core/state.js'
import type { Action, Check, ClusterMetrics, SignalCluster } from '../core/types.js'

export interface PolicyInput {
  cluster: SignalCluster
  score: number
  metrics: ClusterMetrics
  /** Worst-case cost of the planned investigation at the gateway's prices; null if prices are unknown. */
  estimateUsd: number | null
  missionSpentUsd: number
  balanceUsd: number | null
  keyPrefix: string | null
  keyState: string
  paused: boolean
  investigationRunning: boolean
}

export interface PolicyResult {
  action: Action
  reason: string
  checks: Check[]
  budgetUsd: number
}

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`

export const budgetLimits = (missionSpentUsd: number, budgetUsd = missionBudgetUsd()) => {
  const reserve = budgetUsd * POLICY.reserveShare
  const cap = budgetUsd * POLICY.maxPerInvestigationShare
  const remaining = Math.max(0, budgetUsd - missionSpentUsd)
  return { reserve, cap, remaining, available: Math.max(0, Math.min(cap, remaining - reserve)) }
}

export function decide(input: PolicyInput): PolicyResult {
  const { cluster, score, metrics, estimateUsd } = input
  const limits = budgetLimits(input.missionSpentUsd)
  const allocation = Math.min(limits.available, input.balanceUsd ?? 0)
  const cooldown = metrics.similarTo && metrics.similarTo.similarity >= POLICY.cooldownSimilarity ? metrics.similarTo : null

  const checks: Check[] = [
    {
      label: 'On mission',
      ok: metrics.onMission,
      detail: metrics.onMission ? `mentions ${metrics.missionTerms.map((t) => `"${t}"`).join(', ')}` : `no mention of ${MISSION.entity}`,
    },
    {
      label: 'Signal score',
      ok: score >= SIGNAL.investigateAt,
      detail: `${score.toFixed(2)} vs investigate at ${SIGNAL.investigateAt} (watch at ${SIGNAL.watchAt})`,
    },
    {
      label: 'Not already paid for',
      ok: !cluster.investigationId && !cooldown,
      detail: cluster.investigationId
        ? `investigated already (${cluster.investigationId})`
        : cooldown
          ? `${Math.round(cooldown.similarity * 100)}% similar to ${cooldown.clusterId}, investigated in the last ${POLICY.cooldownHours}h`
          : 'new claim',
    },
    {
      label: 'Cost within cap',
      ok: estimateUsd !== null && estimateUsd <= limits.cap,
      detail: estimateUsd === null ? 'gateway prices unavailable' : `worst case ${usd(estimateUsd)} vs cap ${usd(limits.cap)} per investigation`,
    },
    {
      label: 'Reserve protected',
      ok: estimateUsd !== null && allocation >= estimateUsd,
      detail: `${usd(limits.remaining)} left of ${usd(missionBudgetUsd())}, reserve ${usd(limits.reserve)} untouchable → ${usd(allocation)} available`,
    },
    {
      label: 'Orbio balance covers it',
      ok: input.balanceUsd !== null && estimateUsd !== null && input.balanceUsd >= estimateUsd,
      detail: input.balanceUsd === null ? 'balance not read yet' : `real balance ${usd(input.balanceUsd)}`,
    },
    {
      label: 'Key active',
      ok: !!input.keyPrefix,
      detail: input.keyPrefix ? `${input.keyPrefix}…` : `no key (${input.keyState}); paid work disabled`,
    },
    {
      label: 'Agent running',
      ok: !input.paused && !input.investigationRunning,
      detail: input.paused ? 'paused by operator' : input.investigationRunning ? 'another investigation is running' : 'ready',
    },
  ]

  const failed = (label: string) => !checks.find((c) => c.label === label)!.ok
  if (!metrics.onMission) return { action: 'IGNORE', reason: `off mission: no mention of ${MISSION.entity}`, checks, budgetUsd: 0 }
  if (score < SIGNAL.watchAt) return { action: 'IGNORE', reason: `score ${score.toFixed(2)} is below ${SIGNAL.watchAt}: noise, spend nothing`, checks, budgetUsd: 0 }
  if (score < SIGNAL.investigateAt) {
    return { action: 'WATCH', reason: `score ${score.toFixed(2)} is worth watching but not paying for yet`, checks, budgetUsd: 0 }
  }
  const blockers = checks.filter((c) => !c.ok && c.label !== 'Signal score')
  if (blockers.length) {
    const reason =
      failed('Not already paid for') ? 'already investigated: not paying twice for the same claim'
      : failed('Key active') ? 'worth investigating, but the agent holds no key'
      : failed('Reserve protected') || failed('Cost within cap') || failed('Orbio balance covers it') ? 'worth investigating, but the budget says no: reserve protected'
      : 'worth investigating, but ' + blockers.map((b) => b.detail).join('; ')
    return { action: 'WATCH', reason, checks, budgetUsd: 0 }
  }
  const why = [
    metrics.last15 >= 4 && `${metrics.last15} mentions in ${SIGNAL.windowMin} min`,
    metrics.uniqueSources >= 3 && `${metrics.uniqueSources} independent sources`,
    metrics.severityTerms.length && `severity terms (${metrics.severityTerms.slice(0, 3).join(', ')})`,
  ].filter(Boolean)
  return { action: 'INVESTIGATE', reason: `worth buying certainty: ${why.join(' + ') || `score ${score.toFixed(2)}`}`, checks, budgetUsd: allocation }
}
