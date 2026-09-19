// Hunch: the dashboard, its API, the demo fixture's pages, and the agent's schedule, in one
// process.
import './env.js'
import { existsSync, readFileSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { Hono, type Context } from 'hono'
import {
  claimKey, demoCooldownLeft, holdsKey, isBusy, refuel, revokeAgentKey, rotateKey, runDemo, scan, setPaused, snapshot, startAgent,
} from './agent/coordinator.js'
import { treasuryAccount } from './chain/refuel.js'
import { ADMIN_TOKEN, PORT, PUBLIC_URL, SCHEDULE } from './config.js'
import { log } from './core/log.js'
import { saveNow, state } from './core/state.js'
import { demoFeedXml } from './demo/fixture.js'
import { announcementsPage, demoIndexPage, postPage, statusPage } from './demo/pages.js'
import { APP_CSS, APP_JS, dashboardPage } from './web/dashboard.js'

const app = new Hono()

const isAdmin = (c: Context) => !ADMIN_TOKEN || c.req.header('authorization') === `Bearer ${ADMIN_TOKEN}`
const denied = (c: Context) => c.json({ error: 'This control needs the operator token.' }, 401)
const failure = (err: unknown) => (err instanceof Error ? err.message : String(err))

app.get('/', (c) => c.html(dashboardPage()))
// The logo and its exports (brand/): SVG for the page, PNG for favicons and link previews.
const BRAND_TYPES: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png' }
app.get('/brand/:file', (c) => {
  const file = c.req.param('file')
  const type = BRAND_TYPES[file.split('.').pop() ?? '']
  const path = new URL(`../brand/${file}`, import.meta.url)
  if (!type || !/^[\w-]+\.(svg|png)$/.test(file) || !existsSync(path)) return c.notFound()
  return c.body(readFileSync(path), 200, { 'content-type': type, 'cache-control': 'public, max-age=86400' })
})
app.get('/favicon.ico', (c) => c.redirect('/brand/icon-32.png', 301))
app.get('/app.js', (c) => c.body(APP_JS, 200, { 'content-type': 'text/javascript; charset=utf-8' }))
app.get('/app.css', (c) => c.body(APP_CSS, 200, { 'content-type': 'text/css; charset=utf-8' }))
app.get('/api/state', (c) => c.json(snapshot()))
app.get('/api/status', (c) => c.json(snapshot()))
app.get('/api/signals', (c) => c.json(snapshot().signals))
app.get('/api/signals/:id', (c) => {
  const signal = snapshot().signals.find((s) => s.id === c.req.param('id'))
  return signal ? c.json(signal) : c.json({ error: 'not found' }, 404)
})
app.get('/api/investigations/:id', (c) => {
  const inv = state.investigations.find((i) => i.id === c.req.param('id'))
  if (!inv) return c.json({ error: 'not found' }, 404)
  if (c.req.query('download')) c.header('content-disposition', `attachment; filename="hunch-${inv.id}.json"`)
  return c.json({ ...inv, spend: state.spend.filter((s) => s.investigationId === inv.id) })
})
app.get('/api/spend', (c) => c.json(state.spend))

// Scanning is free, so anyone may ask for one, but not more than once a minute.
let lastPublicScan = 0
app.post('/api/scan', (c) => {
  if (!isAdmin(c) && Date.now() - lastPublicScan < 60_000) return c.json({ error: 'A scan ran less than a minute ago.' }, 429)
  if (isBusy().scanning) return c.json({ error: 'A scan is already running.' }, 409)
  lastPublicScan = Date.now()
  scan('manual scan').catch(() => {})
  return c.json({ started: true }, 202)
})

// The demo can spend (one investigation, a few cents, inside the mission budget), so public presses
// are spaced out; the budget policy still has the final say on every cent.
app.post('/api/demo/run', (c) => {
  if (isBusy().demo) return c.json({ error: 'The demo is already running.' }, 409)
  const wait = demoCooldownLeft()
  if (!isAdmin(c) && wait > 0) return c.json({ error: `The demo ran recently. Try again in ${wait}s.` }, 429)
  if (!isAdmin(c)) {
    const since = Date.now() - 24 * 3_600_000
    state.agent.publicDemos = (state.agent.publicDemos ?? []).filter((at) => Date.parse(at) > since)
    if (state.agent.publicDemos.length >= SCHEDULE.publicDemosPerDay) {
      return c.json({ error: `The public demo has run ${SCHEDULE.publicDemosPerDay} times today, its daily limit. Try again tomorrow.` }, 429)
    }
    state.agent.publicDemos.push(new Date().toISOString())
    saveNow()
  }
  runDemo().catch((err) => log('ERROR', `demo failed: ${failure(err)}`))
  return c.json({ started: true }, 202)
})

app.post('/api/key/rotate', async (c) => {
  if (!isAdmin(c)) return denied(c)
  try {
    await rotateKey('operator pressed Rotate')
    return c.json({ ok: true })
  } catch (err) {
    log('ERROR', `rotation failed: ${failure(err)}`)
    return c.json({ error: failure(err) }, 500)
  }
})
app.post('/api/key/revoke', async (c) => {
  if (!isAdmin(c)) return denied(c)
  try {
    await revokeAgentKey('operator pressed Revoke')
    return c.json({ ok: true })
  } catch (err) {
    log('ERROR', `revoke failed: ${failure(err)}`)
    return c.json({ error: failure(err) }, 500)
  }
})
app.post('/api/key/claim', async (c) => {
  if (!isAdmin(c)) return denied(c)
  try {
    await claimKey('operator pressed Claim')
    return c.json({ ok: true })
  } catch (err) {
    log('ERROR', `claim failed: ${failure(err)}`)
    return c.json({ error: failure(err) }, 500)
  }
})
app.post('/api/agent/pause', (c) => {
  if (!isAdmin(c)) return denied(c)
  setPaused(true)
  return c.json({ ok: true })
})
app.post('/api/agent/resume', (c) => {
  if (!isAdmin(c)) return denied(c)
  setPaused(false)
  return c.json({ ok: true })
})
// Refuel now, from the treasury. The policy also refuels on its own when the runway runs short.
app.post('/api/refuel', (c) => {
  if (!isAdmin(c)) return denied(c)
  if (!treasuryAccount()) return c.json({ error: 'No treasury wallet is configured.' }, 400)
  refuel('operator', 'operator pressed Refuel').catch((err) => log('ERROR', `refuel failed: ${failure(err)}`))
  return c.json({ started: true }, 202)
})
app.get('/api/operator', (c) => c.json({ required: !!ADMIN_TOKEN, ok: isAdmin(c) }))

// The demo fixture's world: four planted feeds, each post's page, and Project X's own pages.
app.get('/demo', (c) => c.html(demoIndexPage()))
app.get('/demo/feeds/:file', (c) => {
  const xml = demoFeedXml(c.req.param('file').replace(/\.xml$/, ''), PUBLIC_URL)
  return xml ? c.body(xml, 200, { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'no-store' }) : c.notFound()
})
app.get('/demo/posts/:id', (c) => {
  const html = postPage(c.req.param('id'))
  return html ? c.html(html) : c.notFound()
})
app.get('/demo/projectx/status', (c) => c.html(statusPage()))
app.get('/demo/projectx/announcements', (c) => c.html(announcementsPage()))

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Hunch on ${PUBLIC_URL}`)
  startAgent().then(() => {
    if (!SCHEDULE.enabled) return
    setTimeout(() => scan('first scan').catch(() => {}), 5_000)
    setInterval(() => {
      if (!state.agent.paused && !isBusy().scanning) scan('scheduled scan').catch(() => {})
    }, SCHEDULE.scanEveryMin * 60_000)
  })
})

// Leave no key behind: on shutdown the agent revokes its key (the balance is untouched).
let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  saveNow()
  if (holdsKey()) await Promise.race([
    revokeAgentKey(`agent shutting down (${signal})`, { hold: false }).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ])
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
