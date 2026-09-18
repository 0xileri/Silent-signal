// The demo fixture: a planted narrative about a fictional "Project X", released in three waves so
// a demo shows the whole arc — one post (noise, spend nothing), a handful (watch), a burst across
// four sources with exploit talk (investigate). It is not organic and never claims to be: every
// page says so, and the README says so.
//
// This app serves the fixture's four feeds, each post's page, and Project X's own status page and
// announcements. The watcher reads the feeds over HTTP like any other source; the investigators
// fetch the status page and announcements like any other evidence. Timestamps are real: a post's
// time is the moment its wave was released.
import { randomBytes } from 'node:crypto'
import { readJson, writeJson } from '../core/store.js'

export const DEMO_SOURCES = [
  { id: 'demo-forum', name: 'Project X community forum (demo)' },
  { id: 'demo-social', name: 'Social feed (demo)' },
  { id: 'demo-news', name: 'News blog (demo)' },
  { id: 'demo-chat', name: 'Chat group (demo)' },
] as const

type DemoSourceId = (typeof DEMO_SOURCES)[number]['id']

export interface DemoPost {
  id: string
  wave: 1 | 2 | 3
  source: DemoSourceId
  author: string
  title: string
  /** HTML; may link to the status page with {status}. */
  body: string
}

export const DEMO_POSTS: DemoPost[] = [
  {
    id: 'f1', wave: 1, source: 'demo-forum', author: 'maria_k', title: 'Withdrawal stuck?',
    body: "Is anyone else's Project X withdrawal stuck? Mine has been pending for 40 minutes. Normally it clears in two.",
  },
  {
    id: 's1', wave: 2, source: 'demo-social', author: '@dex_trader', title: '',
    body: 'Project X withdrawals not going through for me either. Pending for over an hour now.',
  },
  {
    id: 'f2', wave: 2, source: 'demo-forum', author: '0xnoodle', title: 'Re: Withdrawal stuck?',
    body: "Same here, my Project X withdrawal is still pending. Support hasn't replied yet.",
  },
  {
    id: 'c1', wave: 2, source: 'demo-chat', author: 'ben', title: '',
    body: "anyone else seeing Project X withdrawals stuck?? mine won't go through",
  },
  {
    id: 'n1', wave: 3, source: 'demo-news', author: 'Staff writer',
    title: 'Users report Project X withdrawals stuck for over an hour',
    body:
      "A growing number of Project X users on social media and the project's community forum say their withdrawals have been stuck as pending for more than an hour. Project X had not commented publicly at the time of writing.",
  },
  {
    id: 'c2', wave: 3, source: 'demo-chat', author: 'anon_4412', title: '',
    body: 'Project X withdrawals frozen. Possible exploit?? Get your funds out while you still can',
  },
  {
    id: 's2', wave: 3, source: 'demo-social', author: '@chainwatch_alerts', title: '',
    body: "Hearing Project X got drained and that's why withdrawals are halted. Can anyone confirm?",
  },
  {
    id: 's3', wave: 3, source: 'demo-social', author: '@yield_farmer99', title: '',
    body: 'Project X withdrawals are failing for everyone right now. Something is very wrong.',
  },
  {
    id: 'f3', wave: 3, source: 'demo-forum', author: 'sam_b', title: 'Withdrawals pending 2 hours, exploit?',
    body: 'Withdrawals from Project X have been pending for 2 hours. Is this an exploit? Their status page: <a href="{status}">{status}</a>',
  },
]

export interface FixtureRun {
  runId: string
  startedAt: string
  released: { wave: number; at: string }[]
}

let run: FixtureRun | null = readJson<FixtureRun | null>('demo.json', null)

export const fixtureRun = () => run

export function startFixtureRun(): FixtureRun {
  run = { runId: randomBytes(3).toString('hex'), startedAt: new Date().toISOString(), released: [] }
  writeJson('demo.json', run)
  return run
}

export function releaseWave(wave: number): DemoPost[] {
  if (!run) throw new Error('No demo run in progress')
  run.released.push({ wave, at: new Date().toISOString() })
  writeJson('demo.json', run)
  return DEMO_POSTS.filter((p) => p.wave === wave)
}

/** A post's time: its wave's release, spaced a few seconds apart within the wave. */
function publishedAt(post: DemoPost): string | null {
  const release = run?.released.find((r) => r.wave === post.wave)
  if (!release) return null
  const inWave = DEMO_POSTS.filter((p) => p.wave === post.wave)
  const behind = inWave.length - 1 - inWave.indexOf(post)
  return new Date(Date.parse(release.at) - behind * 4_000).toISOString()
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function demoFeedXml(sourceId: string, publicUrl: string): string | null {
  const source = DEMO_SOURCES.find((s) => s.id === sourceId)
  if (!source) return null
  const posts = DEMO_POSTS.filter((p) => p.source === sourceId && publishedAt(p))
  const items = posts
    .map((p) => {
      const body = p.body.replaceAll('{status}', `${publicUrl}/demo/projectx/status`)
      return `<item>
<title>${esc(p.title || p.body.replace(/<[^>]+>/g, '').slice(0, 80))}</title>
<link>${publicUrl}/demo/posts/${p.id}</link>
<guid isPermaLink="false">${run!.runId}-${p.id}</guid>
<pubDate>${new Date(publishedAt(p)!).toUTCString()}</pubDate>
<author>${esc(p.author)}</author>
<description>${esc(`<p>${body}</p>`)}</description>
</item>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${esc(source.name)}</title>
<link>${publicUrl}/demo</link>
<description>Silent Signal demo fixture: planted posts about a fictional project. Not organic.</description>
${items}
</channel></rss>`
}

export function demoPost(id: string) {
  const post = DEMO_POSTS.find((p) => p.id === id)
  if (!post) return null
  const source = DEMO_SOURCES.find((s) => s.id === post.source)!
  return { ...post, sourceName: source.name, publishedAt: publishedAt(post) }
}

/** Project X's timeline, anchored to the current demo run so the pages agree with the posts. */
export function projectXTimeline() {
  const t0 = Date.parse(run?.startedAt ?? new Date().toISOString())
  const at = (minutes: number) => new Date(t0 + minutes * 60_000)
  return {
    announcedAt: at(-26 * 60),
    maintenanceStart: at(-55),
    updateAt: at(-20),
    expectedEnd: at(65),
  }
}
