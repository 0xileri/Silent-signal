// The signal score: a fixed weighted sum of five local measurements, each normalized to 0..1.
// Deterministic and free — no model decides whether seven posts are worth a look.
//
//   score = 0.30 velocity + 0.25 source diversity + 0.20 cluster size + 0.15 severity + 0.10 novelty
import { MISSION, POLICY, SIGNAL } from '../config.js'
import type { ClusterMetrics, Factors, SignalCluster, SourceItem } from '../core/types.js'
import { cosine } from './embed.js'
import { meanSimilarity } from './cluster.js'

const SEVERITY: [RegExp, number][] = [
  [/\b(exploit(ed|s)?|hack(ed|s)?|drain(ed|s)?|stolen|rug ?pull(ed)?|insolven(t|cy)|bankrupt(cy)?)\b/gi, 1],
  [/\b(halt(ed|s)?|frozen|freez(e|ing)|suspend(ed|s)?|paused|can'?t withdraw|unable to withdraw|lost funds)\b/gi, 0.8],
  [/\b(stuck|fail(ing|ed|s)?|delay(ed|s)?|pending|outage|down|not going through|won'?t go through|bug|errors?)\b/gi, 0.5],
]

export function severityOf(text: string): { weight: number; terms: { term: string; weight: number }[] } {
  let weight = 0.1
  const terms: { term: string; weight: number }[] = []
  for (const [pattern, w] of SEVERITY) {
    const found = text.match(pattern)
    if (found) {
      weight = Math.max(weight, w)
      terms.push(...found.map((t) => ({ term: t.toLowerCase(), weight: w })))
    }
  }
  return { weight, terms }
}

const clamp = (n: number) => Math.max(0, Math.min(1, n))
const round2 = (n: number) => Math.round(n * 100) / 100
const timeOf = (item: SourceItem) => Date.parse(item.publishedAt ?? item.fetchedAt)

export function measure(
  cluster: SignalCluster,
  items: Map<string, SourceItem>,
  clusters: SignalCluster[],
  now = Date.now(),
): { metrics: ClusterMetrics; factors: Factors; score: number } {
  const members = cluster.itemIds.map((id) => items.get(id)).filter((i): i is SourceItem => !!i)
  const times = members.map(timeOf).sort((a, b) => a - b)
  const window = SIGNAL.windowMin * 60_000
  const last15 = times.filter((t) => t > now - window).length
  const prev15 = times.filter((t) => t <= now - window && t > now - 2 * window).length
  const sources = [...new Set(members.map((m) => m.sourceName))]

  const severities = members.map((m) => severityOf(`${m.title} ${m.text}`))
  const maxSeverity = Math.max(...severities.map((s) => s.weight))
  const meanSeverity = severities.reduce((sum, s) => sum + s.weight, 0) / severities.length
  // Most severe first, so "exploit" leads "pending" wherever the terms are quoted.
  const severityTerms = [...new Set(severities.flatMap((s) => s.terms).sort((a, b) => b.weight - a.weight).map((t) => t.term))]

  const haystack = members.map((m) => `${m.title} ${m.text}`.toLowerCase()).join('\n')
  const missionTerms = MISSION.terms.filter((term) => haystack.includes(term))

  // Novelty: how different this claim is from anything already paid for recently.
  let similarTo: ClusterMetrics['similarTo'] = null
  const since = now - POLICY.cooldownHours * 3_600_000
  for (const other of clusters) {
    if (other.id === cluster.id || other.state === 'archived' || !other.investigationId) continue
    if (Date.parse(other.updatedAt) < since) continue
    const similarity = cosine(cluster.centroid, other.centroid)
    if (!similarTo || similarity > similarTo.similarity) similarTo = { clusterId: other.id, similarity: round2(similarity) }
  }

  const factors: Factors = {
    velocity: round2(clamp(last15 / SIGNAL.velocityFull)),
    diversity: round2(clamp((sources.length - 1) / SIGNAL.diversityFull)),
    size: round2(clamp((members.length - 1) / SIGNAL.sizeFull)),
    severity: round2(0.5 * maxSeverity + 0.5 * meanSeverity),
    novelty: round2(similarTo ? clamp(1 - similarTo.similarity) : 1),
  }
  const w = SIGNAL.weights
  const score = round2(
    clamp(
      w.velocity * factors.velocity +
        w.diversity * factors.diversity +
        w.size * factors.size +
        w.severity * factors.severity +
        w.novelty * factors.novelty,
    ),
  )
  return {
    metrics: {
      mentions: members.length,
      uniqueSources: sources.length,
      sources,
      last15,
      prev15,
      meanSimilarity: round2(meanSimilarity(cluster, items)),
      severityTerms,
      missionTerms,
      onMission: missionTerms.length > 0,
      firstSeen: new Date(times[0] ?? now).toISOString(),
      lastSeen: new Date(times.at(-1) ?? now).toISOString(),
      similarTo,
    },
    factors,
    score,
  }
}
