// Evidence gathering is plain HTTP and costs nothing: the mission's official sources, plus any
// pages the clustered posts link to. The cross-checker then pays only to read what was fetched.
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
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

/** Loopback, private, link-local, CGNAT and unspecified addresses, v4 and v6. */
function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase()
    if (v.startsWith('::ffff:')) return privateAddress(v.slice(7))
    return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')
  }
  const [a, b] = ip.split('.').map(Number) as [number, number]
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

/** A linked page may only be a public http(s) host: no localhost, private ranges or internal names. */
async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`refused ${url.protocol} link`)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (/^localhost$|\.local$|\.internal$|\.localhost$/i.test(host)) throw new Error(`refused internal host ${host}`)
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address)
  if (!addresses.length || addresses.some(privateAddress)) throw new Error(`refused non-public host ${host}`)
}

/** Official sources are the mission's own configuration; linked pages are checked at every redirect. */
async function safeFetch(url: string, kind: EvidenceDoc['kind']): Promise<Response> {
  const init = {
    headers: { 'user-agent': 'Hunch/0.1 (evidence check)', accept: 'text/html, text/plain;q=0.9, */*;q=0.5' },
    signal: AbortSignal.timeout(10_000),
  }
  if (kind === 'official') return fetch(url, init)
  let current = new URL(url)
  for (let hop = 0; hop <= 3; hop++) {
    await assertPublic(current)
    const res = await fetch(current, { ...init, redirect: 'manual' })
    const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (!next) return res
    current = new URL(next, current)
  }
  throw new Error('too many redirects')
}

async function fetchDoc(ref: string, target: { name: string; url: string; kind: EvidenceDoc['kind'] }): Promise<EvidenceDoc> {
  try {
    const res = await safeFetch(target.url, target.kind)
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
