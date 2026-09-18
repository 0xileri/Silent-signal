// Groups posts that make the same claim. A new item joins the cluster whose centroid it is most
// similar to, if that similarity clears the threshold; otherwise it starts a cluster of its own.
// Demo fixture items only ever cluster with each other, so the planted narrative can't absorb (or
// be absorbed by) real posts and the demo stays reproducible.
import { randomBytes } from 'node:crypto'
import { SIGNAL } from '../config.js'
import type { SignalCluster, SourceItem } from '../core/types.js'
import { centroid, claimText, cosine } from './embed.js'

export function assignToCluster(item: SourceItem, clusters: SignalCluster[], items: Map<string, SourceItem>): SignalCluster {
  let best: SignalCluster | undefined
  let bestSim = -1
  for (const cluster of clusters) {
    if (cluster.state === 'archived' || cluster.demo !== item.demo) continue
    const sim = cosine(item.embedding, cluster.centroid)
    if (sim > bestSim) {
      best = cluster
      bestSim = sim
    }
  }
  const now = new Date().toISOString()
  if (best && bestSim >= SIGNAL.clusterSimilarity) {
    best.itemIds.push(item.id)
    refresh(best, items)
    best.updatedAt = now
    return best
  }
  const cluster: SignalCluster = {
    id: `sig_${randomBytes(3).toString('hex')}`,
    representativeClaim: '',
    itemIds: [item.id],
    centroid: item.embedding,
    createdAt: now,
    updatedAt: now,
    state: 'new',
    decisions: [],
    investigationId: null,
    demo: item.demo,
  }
  refresh(cluster, items)
  clusters.push(cluster)
  return cluster
}

/** Recomputes the centroid and picks the member closest to it as the cluster's wording. */
export function refresh(cluster: SignalCluster, items: Map<string, SourceItem>): void {
  const members = cluster.itemIds.map((id) => items.get(id)).filter((i): i is SourceItem => !!i)
  if (!members.length) return
  cluster.centroid = centroid(members.map((m) => m.embedding))
  const central = members.reduce((a, b) => (cosine(b.embedding, cluster.centroid) > cosine(a.embedding, cluster.centroid) ? b : a))
  const claim = claimText(central).replace(/\s+/g, ' ')
  cluster.representativeClaim = claim.length > 160 ? `${claim.slice(0, 157)}…` : claim
}

export function meanSimilarity(cluster: SignalCluster, items: Map<string, SourceItem>): number {
  const members = cluster.itemIds.map((id) => items.get(id)).filter((i): i is SourceItem => !!i)
  if (members.length < 2) return 1
  return members.reduce((sum, m) => sum + cosine(m.embedding, cluster.centroid), 0) / members.length
}
