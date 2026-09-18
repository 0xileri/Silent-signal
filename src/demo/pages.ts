// The fictional Project X's public pages and the planted posts, as plain HTML. The disclosure sits
// in each page's <footer>, shown at the top for people reading along.
import { DEMO_POSTS, DEMO_SOURCES, demoPost, fixtureRun, projectXTimeline } from './fixture.js'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const utc = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
body{margin:0;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f7f7f5;color:#1c1c1a}
main{max-width:720px;margin:0 auto;padding:24px 16px 64px}
footer{background:#fff4d6;color:#7a5200;padding:10px 16px;font-size:.9rem;text-align:center}
footer a{color:inherit}
h1{font-size:1.6rem;margin:12px 0}
.row{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid #e5e5e0}
.ok{color:#1f7a4d;font-weight:600}.warn{color:#9a6700;font-weight:600}
.update{background:#fff;border:1px solid #e5e5e0;border-radius:10px;padding:12px 14px;margin:12px 0}
.meta{color:#6b6b66;font-size:.88rem}
@media (prefers-color-scheme: dark){body{background:#151513;color:#ecece6}.update{background:#1e1e1b;border-color:#33332e}.row{border-color:#33332e}footer{background:#33280c;color:#f2c14e}}
</style></head>
<body><footer>Demo fixture for <a href="/">Hunch</a>: "Project X" is fictional and these pages are planted test data.</footer>
<main>${body}</main></body></html>`
}

export function statusPage(): string {
  const t = projectXTimeline()
  return page(
    'Project X status',
    `<h1>Project X system status</h1>
<div class="row"><span>Trading</span><span class="ok">Operational</span></div>
<div class="row"><span>Deposits</span><span class="ok">Operational</span></div>
<div class="row"><span>Withdrawals</span><span class="warn">Degraded: scheduled maintenance</span></div>
<div class="row"><span>Security incidents</span><span class="ok">None reported</span></div>
<h2>Incident history</h2>
<div class="update"><strong>Update, ${utc(t.updateAt)}</strong><br>
The hot-wallet migration is in progress. Withdrawals are queued and will be processed in order once maintenance completes, expected by ${utc(t.expectedEnd)}. Deposits and trading are not affected. There has been no security incident and no user funds are at risk.</div>
<div class="update"><strong>Maintenance started, ${utc(t.maintenanceStart)}</strong><br>
Scheduled maintenance has begun. Withdrawals may be delayed for up to two hours while we migrate our hot-wallet infrastructure.</div>
<p class="meta">Maintenance was announced on ${utc(t.announcedAt)}. See <a href="/demo/projectx/announcements">announcements</a>.</p>`,
  )
}

export function announcementsPage(): string {
  const t = projectXTimeline()
  return page(
    'Project X announcements',
    `<h1>Project X announcements</h1>
<article class="update"><h2>Scheduled maintenance: hot-wallet migration</h2>
<p class="meta">Posted ${utc(t.announcedAt)} by the Project X team</p>
<p>On ${utc(t.maintenanceStart)} we will migrate our hot wallets to new infrastructure. Deposits and trading are unaffected. Withdrawals requested during the window will be queued for up to two hours and processed in order afterwards.</p>
<p>We will never ask you to move your funds or send them anywhere. Follow the status page for live updates.</p></article>`,
  )
}

export function postPage(id: string): string | null {
  const post = demoPost(id)
  if (!post) return null
  const body = post.body.replaceAll('{status}', '/demo/projectx/status')
  return page(
    post.title || `Post by ${post.author}`,
    `<p class="meta">${esc(post.sourceName)} · ${esc(post.author)} · ${post.publishedAt ? utc(new Date(post.publishedAt)) : 'not released in this run yet'}</p>
${post.title ? `<h1>${esc(post.title)}</h1>` : ''}<p>${body}</p>`,
  )
}

export function demoIndexPage(): string {
  const run = fixtureRun()
  const rows = DEMO_POSTS.map((p) => {
    const source = DEMO_SOURCES.find((s) => s.id === p.source)!
    return `<div class="row"><span>Wave ${p.wave} · ${esc(source.name)} · ${esc(p.author)}</span><a href="/demo/posts/${p.id}">${esc(p.title || p.body.replace(/<[^>]+>/g, '').slice(0, 60))}</a></div>`
  }).join('')
  return page(
    'Hunch demo fixture',
    `<h1>The demo fixture</h1>
<p>Nine planted posts about a fictional project, released in three waves across four feeds, plus the project's own <a href="/demo/projectx/status">status page</a> and <a href="/demo/projectx/announcements">announcements</a>. The agent reads the feeds over HTTP like any real source.</p>
<p class="meta">Current run: ${run ? `${run.runId}, started ${utc(new Date(run.startedAt))}, waves released: ${run.released.map((r) => r.wave).join(', ') || 'none'}` : 'none yet'}</p>
${DEMO_SOURCES.map((s) => `<div class="row"><span>${esc(s.name)}</span><a href="/demo/feeds/${s.id}.xml">feed</a></div>`).join('')}
<h2>Posts</h2>${rows}`,
  )
}
