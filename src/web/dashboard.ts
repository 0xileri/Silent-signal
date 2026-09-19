// The one-page dashboard. The page is a shell; app.js fills it from /api/state every second and a
// half, so everything on screen is the agent's live state.
import { readFileSync } from 'node:fs'
import { MISSION, PUBLIC_URL, REPO_URL } from '../config.js'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const APP_JS = readFileSync(new URL('./app.js', import.meta.url), 'utf8')
export const APP_CSS = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

const WORDMARK =
  'M4 4V40M4 26A9 9 0 0 1 22 26V40M33 16V30A9 9 0 0 0 51 30M51 16V40M62 16V40M62 26A9 9 0 0 1 80 26V40M111.5 19.5A12 12 0 1 0 111.5 36.5M122.5 4V40M122.5 26A9 9 0 0 1 140.5 26V40'

const logo = `<svg class="logo" viewBox="4 4 214 56" role="img" aria-label="Hunch"><circle class="d1" cx="14" cy="46" r="4.5"/><circle class="d2" cx="27" cy="36" r="6.5"/><circle class="d3" cx="45" cy="22" r="10.5"/><path transform="translate(70 11)" d="${WORDMARK}" fill="none" stroke="currentColor" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`

const icon = (d: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`

const STEPS = [
  {
    n: '01', title: 'Watch', cost: '$0', tone: 'free',
    text: 'Reads live public feeds and embeds every post on the server with a small open model.',
    icon: icon('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'),
  },
  {
    n: '02', title: 'Score', cost: '$0', tone: 'free',
    text: 'Clusters same-claim posts and scores velocity, sources, size, severity and novelty.',
    icon: icon('<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>'),
  },
  {
    n: '03', title: 'Decide', cost: '$0', tone: 'free',
    text: 'The coordinator weighs the hunch against its budget, reserve, cap and key.',
    icon: icon('<path d="M12 3v18"/><path d="M5 7h14"/><path d="m5 7-3 6h6Z"/><path d="m19 7-3 6h6Z"/>'),
  },
  {
    n: '04', title: 'Prove', cost: 'paid', tone: 'paid',
    text: 'Workers hired by auction trace the origin and check sources; a verifier writes the finding.',
    icon: icon('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/><path d="m8.5 11 2 2 4-4"/>'),
  },
  {
    n: '05', title: 'Refuel', cost: 'on-chain', tone: 'chain',
    text: 'Running low, it buys CREDIT on Robinhood Chain and activates it into its own balance.',
    icon: icon('<path d="M3 22V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v17"/><path d="M3 22h12"/><path d="M15 9h2a2 2 0 0 1 2 2v6a2 2 0 0 0 4 0V8l-3-3"/><path d="M7 7h4"/>'),
  },
]

const KPIS = [
  { id: 'balance', label: 'Real Orbio balance', hint: 'orbio_get_balance' },
  { id: 'spent', label: 'Spent by the agent', hint: 'every paid call, metered' },
  { id: 'investigations', label: 'Investigations', hint: 'funded after a decision' },
  { id: 'refueled', label: 'Refueled on-chain', hint: 'buyAndActivate, confirmed' },
  { id: 'runway', label: 'Runway', hint: 'investigations left' },
]

export function dashboardPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hunch · free hunches, paid proof</title>
<meta name="description" content="An agent on its own Orbio key. It watches public sources for free and pays for inference only when a story is worth checking.">
<meta name="theme-color" content="#07080a">
<link rel="icon" href="/brand/icon.svg" type="image/svg+xml">
<link rel="icon" href="/brand/icon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/brand/icon-180.png">
<meta property="og:title" content="Hunch: free hunches, paid proof">
<meta property="og:description" content="An agent on its own Orbio key. It watches public sources for free and pays for inference only when a story is worth checking.">
<meta property="og:image" content="${PUBLIC_URL}/brand/og.png">
<meta property="og:url" content="${PUBLIC_URL}">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&family=Geist+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div class="backdrop" aria-hidden="true"><div class="gridlines"></div><div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div></div>

<header class="nav">
  <div class="nav-inner">
    <a class="brand" href="/" aria-label="Hunch home">${logo}</a>
    <nav class="links" aria-label="Sections">
      <a href="#signal">Signal</a><a href="#investigation">Investigation</a><a href="#market">Market</a><a href="#wallet">Fuel</a><a href="#log">Log</a>
    </nav>
    <div class="nav-right">
      <div class="phase" id="phase" aria-live="polite">…</div>
      ${REPO_URL ? `<a class="gh" href="${esc(REPO_URL)}" aria-label="Code on GitHub">${icon('<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>')}</a>` : ''}
    </div>
  </div>
</header>

<section class="hero">
  <div class="hero-copy">
    <div class="eyebrow"><span class="live-dot"></span>Live on Orbio · refuels on-chain</div>
    <h1>Free hunches.<br><span class="grad">Paid proof.</span></h1>
    <p class="lede">An agent with a finite inference budget. It watches public sources and scores emerging narratives for free, spends its own Orbio credits on proof only when a hunch is strong enough, and refuels itself on-chain when it runs low.</p>
    <div class="cta">
      <button class="primary" id="btn-demo">Run demo fixture</button>
      <button class="glass" id="btn-scan">Scan now</button>
      <button class="ghost" id="btn-pause">Pause agent</button>
    </div>
    <p class="mission-line"><span class="k">mission</span>${esc(MISSION.statement)}</p>
    <p class="fineprint">The demo plants nine posts about a fictional "Project X" in three waves (<a href="/demo">see the fixture</a>). They are not organic. Every other source is a live public feed, and every balance and cost on this page is real.</p>
  </div>
  <div class="hero-art" aria-hidden="true">
    <div class="orbit o1"></div><div class="orbit o2"></div><div class="orbit o3"></div>
    <div class="halo"></div>
    <svg class="dots" viewBox="0 0 64 64"><circle class="d1 f1" cx="14" cy="46" r="4.5"/><circle class="d2 f2" cx="27" cy="36" r="6.5"/><circle class="d3 f3" cx="45" cy="22" r="10.5"/></svg>
    <span class="float-chip c1"><b>0.21</b> IGNORE</span>
    <span class="float-chip c2"><b>0.57</b> WATCH</span>
    <span class="float-chip c3"><b>0.97</b> INVESTIGATE</span>
    <span class="float-chip c4" id="chip-fuel">refuels on-chain</span>
  </div>
</section>

<section class="kpis reveal" aria-label="Live numbers">
  ${KPIS.map((k) => `<div class="kpi"><span class="kpi-label">${k.label}</span><strong class="kpi-value" id="kpi-${k.id}">—</strong><span class="kpi-hint" id="kpi-${k.id}-hint">${k.hint}</span></div>`).join('')}
</section>

<section class="how reveal" aria-label="How it works">
  ${STEPS.map((s) => `<div class="step ${s.tone}"><div class="step-top"><span class="step-icon">${s.icon}</span><span class="step-n">${s.n}</span></div><h3>${s.title}</h3><p>${s.text}</p><span class="cost ${s.tone}">${s.cost}</span></div>`).join('')}
</section>

<nav class="machine reveal" id="machine" aria-label="Agent state"></nav>

<div class="grid">
  <div class="col">
    <section class="card reveal" id="signal"></section>
    <section class="card reveal" id="investigation"></section>
  </div>
  <div class="col side">
    <section class="card reveal" id="wallet"></section>
    <section class="card reveal" id="log"></section>
  </div>
</div>

<div class="grid3">
  <section class="card reveal" id="spend"></section>
  <section class="card reveal" id="market"></section>
  <section class="card reveal" id="background"></section>
  <section class="card reveal" id="sources"></section>
</div>

<footer>
  <div class="foot-inner">
    <a class="brand" href="/" aria-label="Hunch home">${logo}</a>
    <p>Runs on its own <a href="https://orbio.so">Orbio</a> key · embeddings: all-MiniLM-L6-v2, locally · fuel: <a href="https://www.orbio.so/protocol/agents">CREDIT</a> on Robinhood Chain · built for Orbio Build Week${REPO_URL ? ` · <a href="${esc(REPO_URL)}">code</a>` : ''}</p>
  </div>
</footer>
<div class="toast" id="toast" role="status"></div>
<script src="/app.js"></script>
</body>
</html>`
}
