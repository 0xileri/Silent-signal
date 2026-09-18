// The one-page dashboard. The page is a shell; public/app.js fills it from /api/state every
// second and a half, so everything on screen is the agent's live state.
import { readFileSync } from 'node:fs'
import { MISSION, REPO_URL } from '../config.js'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const APP_JS = readFileSync(new URL('./app.js', import.meta.url), 'utf8')
export const APP_CSS = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

export function dashboardPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Silent Signal</title>
<meta name="description" content="An autonomous agent that watches public sources for free and spends its own Orbio inference budget only when an emerging narrative is worth investigating.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='5' fill='%23e8590c'/><circle cx='16' cy='16' r='11' fill='none' stroke='%23e8590c' stroke-width='2.5' opacity='.5'/></svg>">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header class="top">
  <div class="brand"><span class="dot" aria-hidden="true"></span>SILENT SIGNAL</div>
  <div class="mission"><span class="k">mission</span> ${esc(MISSION.statement)}</div>
  <div class="phase" id="phase" aria-live="polite">…</div>
</header>

<section class="intro">
  <p>An agent with a finite Orbio budget. It reads public sources and clusters them <b>for free</b>, and spends its own credits only when the coordinator decides a narrative is worth investigating.</p>
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
