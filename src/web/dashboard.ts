// The one-page dashboard. The page is a shell; public/app.js fills it from /api/state every
// second and a half, so everything on screen is the agent's live state.
import { readFileSync } from 'node:fs'
import { MISSION, PUBLIC_URL, REPO_URL } from '../config.js'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const APP_JS = readFileSync(new URL('./app.js', import.meta.url), 'utf8')
export const APP_CSS = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

export function dashboardPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hunch</title>
<meta name="description" content="An autonomous agent that watches public sources for free and spends its own Orbio inference budget only when an emerging narrative is worth investigating.">
<link rel="icon" href="/brand/icon.svg" type="image/svg+xml">
<link rel="icon" href="/brand/icon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/brand/icon-180.png">
<meta property="og:title" content="Hunch: free hunches, paid proof">
<meta property="og:description" content="An agent on its own Orbio key. It watches public sources for free and pays for inference only when a story is worth checking.">
<meta property="og:image" content="${PUBLIC_URL}/brand/og.png">
<meta property="og:url" content="${PUBLIC_URL}">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header class="top">
  <a class="brand" href="/"><svg class="logo" viewBox="4 4 214 56" role="img" aria-label="Hunch"><circle class="d1" cx="14" cy="46" r="4.5"/><circle class="d2" cx="27" cy="36" r="6.5"/><circle class="d3" cx="45" cy="22" r="10.5"/><path transform="translate(70 11)" d="M4 4V40M4 26A9 9 0 0 1 22 26V40M33 16V30A9 9 0 0 0 51 30M51 16V40M62 16V40M62 26A9 9 0 0 1 80 26V40M111.5 19.5A12 12 0 1 0 111.5 36.5M122.5 4V40M122.5 26A9 9 0 0 1 140.5 26V40" fill="none" stroke="currentColor" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="tagline">free hunches · paid proof</span></a>
  <div class="mission"><span class="k">mission</span> ${esc(MISSION.statement)}</div>
  <div class="phase" id="phase" aria-live="polite">…</div>
</header>

<section class="intro">
  <p>An agent with a finite Orbio budget. It reads public sources and scores emerging narratives <b>for free</b>: that score is its hunch. It spends its own credits on proof only when the coordinator decides a hunch is strong enough to be worth checking.</p>
  <div class="controls">
    <button class="primary" id="btn-demo">Run demo fixture</button>
    <button id="btn-scan">Scan now</button>
    <button id="btn-pause" class="ghost">Pause agent</button>
  </div>
  <p class="fineprint">The demo plants nine posts about a fictional "Project X" in three waves (<a href="/demo">see the fixture</a>). They are not organic. Every other source is a live public feed, and every balance and cost on this page is real.</p>
</section>

<nav class="machine" id="machine" aria-label="Agent state"></nav>

<div class="grid">
  <div class="col">
    <section class="card" id="signal"></section>
    <section class="card" id="investigation"></section>
  </div>
  <div class="col side">
    <section class="card" id="wallet"></section>
    <section class="card" id="log"></section>
  </div>
</div>

<div class="grid3">
  <section class="card" id="spend"></section>
  <section class="card" id="market"></section>
  <section class="card" id="background"></section>
  <section class="card" id="sources"></section>
</div>

<footer>
  Runs on its own <a href="https://orbio.so">Orbio</a> key · embeddings: all-MiniLM-L6-v2, locally · built for Orbio Build Week${REPO_URL ? ` · <a href="${esc(REPO_URL)}">code</a>` : ''}
</footer>
<div class="toast" id="toast" role="status"></div>
<script src="/app.js"></script>
</body>
</html>`
}
