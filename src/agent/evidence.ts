// Evidence gathering is plain HTTP and costs nothing: the mission's official sources, plus any
// pages the clustered posts link to. The cross-checker then pays only to read what was fetched.
import { MISSION } from '../config.js'
import type { EvidenceDoc, SourceItem } from '../core/types.js'
import { htmlToText } from '../watcher/sources.js'

const MAX_DOCS = 6
const EXCERPT_CHARS = 2500

export async function gatherEvidence(posts: SourceItem[]): Promise<EvidenceDoc[]> {
  const targets: { name: string; url: string; kind: EvidenceDoc['kind'] }[] = MISSION.officialSources.map((s) => ({ ...s, kind: 'official' }))
  const seen = new Set(targets.map((t) => normalize(t.url)))
  for (const post of posts) {
    for (const url of post.links) {
      if (seen.has(normalize(url)) || targets.length >= MAX_DOCS) continue
      seen.add(normalize(url))
      targets.push({ name: `linked from ${post.sourceName}`, url, kind: 'linked' })
    }
  }
  const docs = await Promise.all(targets.map((t, i) => fetchDoc(`E${i + 1}`, t)))
  return docs
}

async function fetchDoc(ref: string, target: { name: string; url: string; kind: EvidenceDoc['kind'] }): Promise<EvidenceDoc> {
  try {
    const res = await fetch(target.url, {
      headers: { 'user-agent': 'SilentSignal/0.1 (evidence check)', accept: 'text/html, text/plain;q=0.9, */*;q=0.5' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const type = res.headers.get('content-type') ?? ''
    if (!/text|html|xml|json/.test(type)) throw new Error(`not a text page (${type})`)
    const body = (await res.text()).slice(0, 400_000)
    const title = body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim()
    const text = htmlToText(body.replace(/<head[\s\S]*?<\/head>/i, ''))
    return {
      ref,
      name: title ? `${target.name}: ${title}` : target.name,
      url: target.url,
      kind: target.kind,
      ok: true,
      excerpt: text.slice(0, EXCERPT_CHARS),
      error: null,
    }
  } catch (err) {
    return { ref, ...target, ok: false, excerpt: '', error: err instanceof Error ? err.message : String(err) }
  }
}

const normalize = (url: string) => url.replace(/[#?].*$/, '').replace(/\/$/, '').toLowerCase()
