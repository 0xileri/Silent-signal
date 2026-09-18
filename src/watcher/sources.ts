// The public sources the watcher reads: a short fixed list of RSS feeds, plus the demo fixture's
// planted feeds, which this app serves itself and which are read over HTTP like any other feed.
// Fetching is free, so it never touches the budget. Real feeds are cached for a few minutes, a
// failing source is logged and skipped, and nothing here waits long on a slow site.
import { createHash } from 'node:crypto'
import { XMLParser } from 'fast-xml-parser'
import { PUBLIC_URL, SCHEDULE, SIGNAL } from '../config.js'
import type { Source, SourceItem } from '../core/types.js'
import { DEMO_SOURCES } from '../demo/fixture.js'

const USER_AGENT = 'SilentSignal/0.1 (budget-aware narrative watcher; reads public feeds)'
const MAX_TEXT = 1500

export const REAL_SOURCES: Source[] = [
  { id: 'cointelegraph', name: 'Cointelegraph', type: 'rss', url: 'https://cointelegraph.com/rss' },
  { id: 'decrypt', name: 'Decrypt', type: 'rss', url: 'https://decrypt.co/feed' },
  { id: 'reddit-cryptocurrency', name: 'Reddit r/CryptoCurrency', type: 'reddit', url: 'https://www.reddit.com/r/CryptoCurrency/new/.rss?limit=50' },
  { id: 'hacker-news', name: 'Hacker News front page', type: 'rss', url: 'https://hnrss.org/frontpage' },
]

export function allSources(): Source[] {
  return [
    ...REAL_SOURCES,
    ...DEMO_SOURCES.map((s) => ({ id: s.id, name: s.name, type: 'demo' as const, url: `${PUBLIC_URL}/demo/feeds/${s.id}.xml` })),
  ]
}

export interface FetchReport {
  source: Source
  ok: boolean
  items: number
  cached: boolean
  error: string | null
  at: string
}

export type RawItem = Omit<SourceItem, 'embedding'>

const cache = new Map<string, { at: number; items: RawItem[] }>()

export async function fetchAll(sources = allSources()): Promise<{ items: RawItem[]; reports: FetchReport[] }> {
  const results = await Promise.all(sources.map((source) => fetchOne(source)))
  return { items: results.flatMap((r) => r.items), reports: results.map((r) => r.report) }
}

async function fetchOne(source: Source): Promise<{ items: RawItem[]; report: FetchReport }> {
  const at = new Date().toISOString()
  const hit = cache.get(source.id)
  if (source.type !== 'demo' && hit && Date.now() - hit.at < SCHEDULE.feedCacheMin * 60_000) {
    return { items: hit.items, report: { source, ok: true, items: hit.items.length, cached: true, error: null, at } }
  }
  try {
    const res = await fetch(source.url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/atom+xml, text/xml;q=0.9, */*;q=0.5' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const items = parseFeed(source, await res.text())
    if (source.type !== 'demo') cache.set(source.id, { at: Date.now(), items })
    return { items, report: { source, ok: true, items: items.length, cached: false, error: null, at } }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    // A stale copy beats nothing when a feed hiccups.
    if (hit) return { items: hit.items, report: { source, ok: false, items: hit.items.length, cached: true, error, at } }
    return { items: [], report: { source, ok: false, items: 0, cached: false, error, at } }
  }
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' })

export function parseFeed(source: Source, xml: string): RawItem[] {
  const doc: any = parser.parse(xml) // parsed XML has no fixed shape
  const entries = doc.rss?.channel?.item ?? doc.feed?.entry ?? []
  const fetchedAt = new Date().toISOString()
  const oldest = Date.now() - SIGNAL.retainHours * 3_600_000
  return (Array.isArray(entries) ? entries : [entries])
    .map((entry): RawItem => {
      const link = typeof entry.link === 'string' ? entry.link : [entry.link].flat()[0]?.href
      const published = textOf(entry.published ?? entry.pubDate ?? entry.updated)
      const html = textOf(entry['content:encoded'] ?? entry.content ?? entry.description ?? entry.summary)
      const title = htmlToText(textOf(entry.title))
      const text = htmlToText(html)
        .replace(/\s*submitted by\s+\/u\/\S+.*$/s, '') // Reddit's footer
        .slice(0, MAX_TEXT)
      const url = String(link ?? '')
      const guid = textOf(entry.guid ?? entry.id) || url
      return {
        id: createHash('sha256').update(`${source.id}|${guid}|${title}`).digest('hex').slice(0, 16),
        sourceId: source.id,
        sourceName: source.name,
        sourceType: source.type,
        url,
        title,
        text,
        links: extractLinks(html, url),
        publishedAt: published && !Number.isNaN(Date.parse(published)) ? new Date(published).toISOString() : null,
        fetchedAt,
        demo: source.type === 'demo',
      }
    })
    .filter((item) => (item.title || item.text) && Date.parse(item.publishedAt ?? item.fetchedAt) >= oldest)
}

function extractLinks(html: string, self: string): string[] {
  const found = new Set<string>()
  for (const match of html.matchAll(/href=["']([^"']+)["']|(https?:\/\/[^\s<>"')]+)/gi)) {
    const url = (match[1] ?? match[2] ?? '').replace(/&amp;/g, '&')
    if (/^https?:\/\//i.test(url) && url !== self) found.add(url)
    if (found.size >= 5) break
  }
  return [...found]
}

function textOf(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (value && typeof value === 'object' && '#text' in value) return String(value['#text'])
  return ''
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–', hellip: '…',
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|nav|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
      if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? entity
      const code = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : entity
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}
