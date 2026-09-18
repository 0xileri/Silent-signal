// A one-off trial of the worker pools on the demo fixture: every tracer and cross-checker runs the
// same job on the agent's key, and the market's code checks grade each answer. Used to choose which
// models join the pools; it does not touch the reputation records. Spends about a cent.
import '../env.js'
import { gatherEvidence } from '../agent/evidence.js'
import { BIDDERS, gradeChecker, gradeTracer } from '../agent/market.js'
import {
  CHECKER_SCHEMA, CHECKER_SYSTEM, checkerPrompt, CheckerOutput, MAX_TOKENS, TRACER_SCHEMA, TRACER_SYSTEM, tracerPrompt, TracerOutput,
} from '../agent/workers.js'
import type { SourceItem } from '../core/types.js'
import { DEMO_POSTS, DEMO_SOURCES } from '../demo/fixture.js'
import { meteredCall } from '../orbio/gateway.js'
import { createKey } from '../orbio/keys.js'
import { htmlToText } from '../watcher/sources.js'

const now = Date.now()
const posts: SourceItem[] = DEMO_POSTS.map((p, i) => ({
  id: p.id, sourceId: p.source, sourceName: DEMO_SOURCES.find((s) => s.id === p.source)!.name, sourceType: 'demo', url: `/demo/posts/${p.id}`,
  title: p.title, text: htmlToText(p.body.replaceAll('{status}', '/demo/projectx/status')), links: [],
  publishedAt: new Date(now - (DEMO_POSTS.length - i) * 5000).toISOString(), fetchedAt: new Date(now).toISOString(), embedding: [], demo: true,
}))
const claim = 'Project X withdrawals not going through for me either. Pending for over an hour now.'
const docs = await gatherEvidence(posts)
console.log(`evidence: ${docs.map((d) => `${d.ref} ${d.ok ? 'ok' : d.error}`).join(', ')}`)

const { key } = await createKey('hunch-market-trial')
const meter = { limitUsd: 0.5, spentUsd: 0 }
const run = async <T>(model: string, name: string, system: string, user: string, schema: Record<string, unknown>, maxTokens: number, parse: (v: unknown) => T) => {
  const t0 = Date.now()
  let cost = 0
  try {
    const r = await meteredCall({ key, model, system, user, schemaName: name, schema, maxTokens, meter, parse, onSpend: (s) => (cost = s.costUsd) })
    return { out: r.data, cost, ms: Date.now() - t0, tokens: r.completionTokens, error: null as string | null }
  } catch (err) {
    return { out: null, cost, ms: Date.now() - t0, tokens: 0, error: err instanceof Error ? err.message.slice(0, 120) : String(err) }
  }
}

let subclaims: string[] = [claim]
for (const b of BIDDERS.filter((b) => b.role === 'source-tracer')) {
  const r = await run(b.model, 'trace', TRACER_SYSTEM, tracerPrompt(claim, posts), TRACER_SCHEMA, MAX_TOKENS['source-tracer'], (v) => TracerOutput.parse(v))
  const g = gradeTracer(r.out, posts)
  if (b.id === 'tracer-haiku' && r.out) subclaims = r.out.subclaims.map((s) => s.claim)
  console.log(`${b.id.padEnd(20)} quality ${g.quality.toFixed(2)} · $${r.cost.toFixed(6)} · ${r.ms}ms · ${r.tokens} out · ${r.error ?? g.notes.join('; ')}`)
}
for (const b of BIDDERS.filter((b) => b.role === 'cross-checker')) {
  const r = await run(b.model, 'cross_check', CHECKER_SYSTEM, checkerPrompt(subclaims, docs), CHECKER_SCHEMA, MAX_TOKENS['cross-checker'], (v) => CheckerOutput.parse(v))
  const g = gradeChecker(r.out, docs, subclaims.length)
  console.log(`${b.id.padEnd(20)} quality ${g.quality.toFixed(2)} · $${r.cost.toFixed(6)} · ${r.ms}ms · ${r.tokens} out · ${r.error ?? g.notes.join('; ')}`)
}
console.log(`total spent: $${meter.spentUsd.toFixed(6)}`)
process.exit(0)
