// Checks the free half of the agent offline, with no key and no spend: embeds the demo fixture,
// clusters it wave by wave and prints the score and its factors after each wave. Then does the same
// for the live public feeds, to show real traffic stays below the thresholds.
import '../env.js'
import { SIGNAL } from '../config.js'
import type { SignalCluster, SourceItem } from '../core/types.js'
import { DEMO_POSTS, DEMO_SOURCES } from '../demo/fixture.js'
import { assignToCluster } from '../watcher/cluster.js'
import { claimText, cosine, embed } from '../watcher/embed.js'
import { measure } from '../watcher/score.js'
import { fetchAll, htmlToText, REAL_SOURCES } from '../watcher/sources.js'

const now = Date.now()
const posts = DEMO_POSTS.map((p, i) => ({
  id: `demo-${p.id}`,
  sourceId: p.source,
  sourceName: DEMO_SOURCES.find((s) => s.id === p.source)!.name,
  sourceType: 'demo' as const,
  url: `/demo/posts/${p.id}`,
  title: p.title,
  text: htmlToText(p.body),
  links: [],
  // Waves 1 and 2 land a little earlier than wave 3, as in a live demo.
  publishedAt: new Date(now - (3 - p.wave) * 12_000 - (DEMO_POSTS.length - i) * 1000).toISOString(),
  fetchedAt: new Date(now).toISOString(),
  demo: true,
}))

const vectors = await embed(posts.map(claimText))
const items = new Map<string, SourceItem>(posts.map((p, i) => [p.id, { ...p, embedding: vectors[i]! }]))

console.log('Pairwise cosine similarity of the fixture posts:')
console.log('     ' + posts.map((p) => p.id.slice(5).padStart(5)).join(''))
for (const a of posts) {
  console.log(
    a.id.slice(5).padEnd(5) + posts.map((b) => cosine(items.get(a.id)!.embedding, items.get(b.id)!.embedding).toFixed(2).padStart(5)).join(''),
  )
}

const clusters: SignalCluster[] = []
for (const wave of [1, 2, 3]) {
  for (const p of posts.filter((p) => DEMO_POSTS.find((d) => `demo-${d.id}` === p.id)!.wave === wave)) {
    assignToCluster(items.get(p.id)!, clusters, items)
  }
  console.log(`\nAfter wave ${wave}: ${clusters.length} cluster(s)`)
  for (const c of clusters) {
    const { metrics, factors, score } = measure(c, items, clusters, now)
    const action = score >= SIGNAL.investigateAt ? 'INVESTIGATE' : score >= SIGNAL.watchAt ? 'WATCH' : 'IGNORE'
    console.log(`  ${c.id} "${c.representativeClaim}"`)
    console.log(
      `    mentions ${metrics.mentions} · sources ${metrics.uniqueSources} · last15 ${metrics.last15} · sim ${metrics.meanSimilarity} · severity terms ${metrics.severityTerms.join(', ')}`,
    )
    console.log(`    factors ${JSON.stringify(factors)} → score ${score} → ${action}`)
  }
}

console.log('\nLive public feeds (free):')
const { items: raw, reports } = await fetchAll(REAL_SOURCES)
for (const r of reports) console.log(`  ${r.source.name}: ${r.ok ? `${r.items} items` : `failed (${r.error})`}`)
const liveVectors = await embed(raw.map(claimText))
const live = new Map<string, SourceItem>(raw.map((r, i) => [r.id, { ...r, embedding: liveVectors[i]! }]))
const liveClusters: SignalCluster[] = []
for (const item of live.values()) assignToCluster(item, liveClusters, live)
const scored = liveClusters
  .map((c) => ({ c, ...measure(c, live, liveClusters) }))
  .sort((a, b) => b.score - a.score)
console.log(`  ${live.size} items → ${liveClusters.length} clusters; top 5 by score:`)
for (const { c, metrics, score } of scored.slice(0, 5)) {
  console.log(`   ${score.toFixed(2)}  ${metrics.mentions} mentions / ${metrics.uniqueSources} sources  "${c.representativeClaim.slice(0, 90)}"`)
}
