// Hunch dashboard: polls /api/state and renders it. No framework; every value shown comes
// from the agent's state.
;(() => {
  const $ = (id) => document.getElementById(id)
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const usd = (n, d) => (n === null || n === undefined ? '—' : `$${Number(n).toFixed(d ?? (Math.abs(n) < 1 ? 4 : 2))}`)
  const pct = (n) => `${Math.round(n * 100)}%`
  const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }) : '—')
  const ago = (iso) => {
    if (!iso) return 'never'
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`
  }
  const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : null)
  const last = {}
  const set = (id, html) => {
    if (last[id] === html) return
    last[id] = html
    $(id).innerHTML = html
  }

  let S = null
  let focus = null
  let followLatest = true
  const open = new Set()

  // Keep <details> open across re-renders.
  document.addEventListener('toggle', (e) => {
    const id = e.target.dataset && e.target.dataset.key
    if (!id) return
    if (e.target.open) open.add(id)
    else open.delete(id)
  }, true)
  const det = (key, summary, body) => `<details data-key="${key}" ${open.has(key) ? 'open' : ''}><summary>${summary}</summary>${body}</details>`

  function toast(msg) {
    const t = $('toast')
    t.textContent = msg
    t.classList.add('show')
    clearTimeout(toast.timer)
    toast.timer = setTimeout(() => t.classList.remove('show'), 3500)
  }

  function token() {
    try { return localStorage.getItem('hunch-operator') || '' } catch { return '' }
  }

  async function post(path, retry = true) {
    const headers = {}
    if (token()) headers.authorization = `Bearer ${token()}`
    const res = await fetch(path, { method: 'POST', headers })
    const body = await res.json().catch(() => ({}))
    if (res.status === 401 && retry) {
      const t = prompt('This control needs the operator token:')
      if (t) {
        try { localStorage.setItem('hunch-operator', t) } catch {}
        return post(path, false)
      }
    }
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
    return body
  }

  function action(btn, path, msg) {
    btn.addEventListener('click', async () => {
      btn.disabled = true
      try {
        await post(typeof path === 'function' ? path() : path)
        if (msg) toast(msg)
        followLatest = true
        refresh()
      } catch (err) {
        toast(err.message)
      } finally {
        setTimeout(() => (btn.disabled = false), 800)
      }
    })
  }

  action($('btn-demo'), '/api/demo/run', 'Demo started: three waves, about 12 seconds apart.')
  action($('btn-scan'), '/api/scan', 'Scanning all sources…')
  action($('btn-pause'), () => (S && S.paused ? '/api/agent/resume' : '/api/agent/pause'))
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-key-action]')
    if (b) {
      const act = b.dataset.keyAction
      if (act === 'revoke' && !confirm('Revoke the agent’s Orbio key? Paid work stops until a key is claimed again.')) return
      b.disabled = true
      try {
        await post(`/api/key/${act}`)
        toast(act === 'rotate' ? 'Key rotated; old key checked.' : act === 'revoke' ? 'Key revoked.' : 'Key claimed.')
        refresh()
      } catch (err) {
        toast(err.message)
      } finally {
        b.disabled = false
      }
    }
    const t = e.target.closest('[data-focus]')
    if (t) {
      focus = t.dataset.focus
      followLatest = false
      render()
    }
  })

  // ── state machine ─────────────────────────────────────────────────────────────────────────────
  const STEPS = ['SCANNING', 'EVALUATING', 'WATCHING', 'FUNDING', 'INVESTIGATING', 'VERIFYING', 'ACCEPTED', 'ALERTED']
  function renderPhase() {
    const p = S.phase
    const el = $('phase')
    el.textContent = S.paused ? 'PAUSED' : p
    el.className = 'phase ' + (['SCANNING', 'EVALUATING', 'FUNDING', 'INVESTIGATING', 'VERIFYING'].includes(p) ? 'busy' : ['ACCEPTED', 'ALERTED'].includes(p) ? 'ok' : p === 'REJECTED' ? 'bad' : '')
    const idx = STEPS.indexOf(p === 'REJECTED' ? 'ACCEPTED' : p)
    set('machine', `<span class="${p === 'IDLE' || p === 'STARTING' ? 'on' : ''}">${p === 'STARTING' ? 'STARTING' : 'IDLE'}</span><i>›</i>` +
      STEPS.map((s, i) => {
        const label = s === 'ACCEPTED' && p === 'REJECTED' ? 'REJECTED' : s
        const cls = s === p || (s === 'ACCEPTED' && p === 'REJECTED') ? 'on' : idx > i && s !== 'WATCHING' ? 'done' : ''
        return `<span class="${cls}">${label}</span>` + (i < STEPS.length - 1 ? `<i>${s === 'WATCHING' ? '|' : '›'}</i>` : '')
      }).join(''))
    $('btn-pause').textContent = S.paused ? 'Resume agent' : 'Pause agent'
    const demo = $('btn-demo')
    demo.textContent = S.demo.running ? `Demo running: wave ${S.demo.wave || '…'} of 3` : 'Run demo fixture'
    demo.disabled = S.demo.running
  }

  // ── wallet ────────────────────────────────────────────────────────────────────────────────────
  function renderWallet() {
    const b = S.budget
    const latest = S.balance.latest
    const k = S.key
    const w = (n) => `${Math.max(0, Math.min(100, (n / b.budgetUsd) * 100))}%`
    const avail = Math.max(0, b.remainingUsd - b.reserveUsd)
    const reserveShown = Math.min(b.reserveUsd, b.remainingUsd)
    set('wallet', `
      <h2>Orbio agent <span class="right badge ${S.orbio.connected ? 'ok' : 'bad'}">${S.orbio.connected ? 'connected' : 'offline'}</span></h2>
      ${S.orbio.error ? `<p class="empty" style="color:var(--bad)">${esc(S.orbio.error)}</p>` : ''}
      <div class="k">Real Orbio balance</div>
      <div class="money-big">${latest ? usd(latest.balanceUsd, 4) : '—'}</div>
      <div class="muted" style="font-size:.8rem">orbio_get_balance · ${latest ? `read ${time(latest.at)}` : 'not read yet'}${S.balance.start !== null ? ` · ${usd(S.balance.start, 4)} at agent start` : ''}</div>
      <div style="margin-top:16px" class="k">Mission budget ${usd(b.budgetUsd, 2)}</div>
      <div class="stack" title="spent / available / reserve">
        <div class="spent" style="width:${w(b.spentUsd)}"></div>
        <div class="avail" style="width:${w(avail)}"></div>
        <div class="reserve" style="width:${w(reserveShown)}"></div>
      </div>
      <div class="legend"><span><i style="background:var(--accent)"></i>spent</span><span><i style="background:var(--ok);opacity:.55"></i>available</span><span><i style="background:var(--muted);opacity:.55"></i>reserve (never spent)</span></div>
      <dl class="kv">
        <dt>Spent by the agent</dt><dd>${usd(b.spentUsd, 6)}</dd>
        <dt>Remaining budget</dt><dd>${usd(b.remainingUsd, 4)}</dd>
        <dt>Reserve (${pct(S.policy.reserveShare)})</dt><dd>${usd(b.reserveUsd, 2)}</dd>
        <dt>Cap per investigation (${pct(S.policy.maxPerInvestigationShare)})</dt><dd>${usd(b.capUsd, 2)}</dd>
        <dt>Typical investigation</dt><dd>${b.typicalInvestigationUsd ? usd(b.typicalInvestigationUsd, 4) : '—'}</dd>
        <dt>Runway</dt><dd>${b.runway !== null ? `≈ ${b.runway} investigations` : '—'}</dd>
      </dl>
      <div class="keybox">
        <span class="badge ${esc(k.state)}">${k.state === 'active' ? 'key active' : k.state === 'none' ? 'no key' : `key ${esc(k.state)}`}</span>
        <code>${k.prefix ? esc(k.prefix) + '…' : '—'}</code>
        <span class="btns">
          ${k.prefix ? `<button class="small" data-key-action="rotate">Rotate</button><button class="small danger" data-key-action="revoke">Revoke</button>` : `<button class="small" data-key-action="claim">Claim key</button>`}
        </span>
      </div>
      <ul class="keyevents">${k.events.slice(0, 5).map((e) => `<li>${time(e.at)} <b>${esc(e.event)}</b> ${e.prefix ? esc(e.prefix) + '… ' : ''}· ${esc(e.detail)}</li>`).join('')}</ul>
      <div class="muted" style="font-size:.78rem;margin-top:8px">Workers: ${esc(S.policy.models.worker)} · verifier: ${esc(S.policy.models.verifier)} · anomaly revoke above ${usd(S.policy.anomalyCallUsd, 2)}/call</div>`
)
  }

  // ── signal ────────────────────────────────────────────────────────────────────────────────────
  const FACTORS = [
    ['velocity', 'Velocity'],
    ['diversity', 'Sources'],
    ['size', 'Size'],
    ['severity', 'Severity'],
    ['novelty', 'Novelty'],
  ]

  function renderSignal() {
    const signals = S.signals
    if (followLatest || !signals.find((s) => s.id === focus)) focus = signals[0] ? signals[0].id : null
    const sig = signals.find((s) => s.id === focus)
    if (!sig) {
      set('signal', `<h2>Emerging signal</h2>
        <p class="empty">Nothing on mission yet. The watcher has read <b>${S.stats.itemsRead}</b> items in <b>${S.stats.scans}</b> scans and grouped them into <b>${S.stats.clusters}</b> clusters locally, for $0. None mention ${esc(S.mission.entity)}.</p>
        <p class="empty">Press <b>Run demo fixture</b> to plant a narrative and watch the agent decide whether it is worth paying for.</p>`
)
      return
    }
    const d = sig.decisions[sig.decisions.length - 1]
    const m = d.metrics
    const w = S.policy.signal.weights
    const tabs = signals.length > 1
      ? `<div class="tabs">${signals.map((s) => `<button data-focus="${esc(s.id)}" class="${s.id === sig.id ? 'on' : ''}">${esc(s.id)}${s.demo ? ' · demo' : ''}</button>`).join('')}</div>`
      : ''
    const history = sig.decisions
      .map((x) => `<span class="chip ${x.action}">${time(x.at)} · ${x.score.toFixed(2)} ${x.action}</span>`)
      .join('<span class="arrow">→</span>')
    set('signal', `
      <h2>Emerging signal <span class="badge ${esc(sig.state)}">${esc(sig.state)}</span>${sig.demo ? '<span class="badge warn">demo fixture</span>' : ''}<span class="right mono" style="font-size:.75rem">${esc(sig.id)}</span></h2>
      ${tabs}
      <p class="claim">${esc(sig.claim)}</p>
      <div class="stats">
        <div class="stat"><div class="v">${m.mentions}</div><div class="l">mentions</div></div>
        <div class="stat"><div class="v">${m.uniqueSources}</div><div class="l">independent sources</div></div>
        <div class="stat"><div class="v">${m.last15}<span class="muted" style="font-size:.9rem"> / ${m.prev15}</span></div><div class="l">last 15 min / previous 15</div></div>
        <div class="stat"><div class="v" style="color:var(--${d.action === 'INVESTIGATE' ? 'accent' : d.action === 'WATCH' ? 'warn' : 'idle'})">${d.score.toFixed(2)}</div><div class="l">signal score</div></div>
      </div>
      <div class="decision ${d.action}">
        <div class="act">${d.action}</div>
        <div class="why">${esc(d.reason)}</div>
        <div class="sub">${d.action === 'INVESTIGATE' ? `max budget ${usd(d.budgetUsd, 4)} · planned worst case ${usd(d.estimateUsd, 4)}` : d.action === 'WATCH' ? 'spend: $0 · re-checked on every scan' : 'spend: $0'} · decided ${time(d.at)}</div>
      </div>
      <div class="history">${history}</div>
      <div class="two">
        <div>
          <h3>Why this score (local, $0)</h3>
          ${FACTORS.map(([k, label]) => `<div class="factor"><span>${label} <span class="muted">×${w[k]}</span></span><div class="bar"><i style="width:${d.factors[k] * 100}%"></i></div><span class="n">${d.factors[k].toFixed(2)} → ${(d.factors[k] * w[k]).toFixed(3)}</span></div>`).join('')}
          <div class="scoreline"><span>score</span><span>${d.score.toFixed(2)} · watch ≥ ${S.policy.signal.watchAt} · investigate ≥ ${S.policy.signal.investigateAt}</span></div>
          <p class="muted" style="font-size:.78rem;margin:8px 0 0">similarity ${m.meanSimilarity} · severity terms: ${esc(m.severityTerms.join(', ') || 'none')}</p>
        </div>
        <div>
          <h3>Coordinator checks</h3>
          <ul class="checks">${d.checks.map((c) => `<li><span class="${c.ok ? 'y' : 'x'}">${c.ok ? '✓' : '✗'}</span><span>${esc(c.label)}<span class="d">${esc(c.detail)}</span></span></li>`).join('')}</ul>
        </div>
      </div>
      ${det(`posts-${sig.id}`, `The ${sig.items.length} clustered posts`, `<ul class="posts">${sig.items.map((i) => `<li><div class="m">${time(i.publishedAt)} · ${esc(i.source)}</div>${i.title && !i.text.startsWith(i.title) ? `<b>${esc(i.title)}</b> ` : ''}${esc(i.text)} ${safeUrl(i.url) ? `<a href="${esc(i.url)}" target="_blank" rel="noopener">open</a>` : ''}</li>`).join('')}</ul>`)}`
)
  }

  // ── investigation ─────────────────────────────────────────────────────────────────────────────
  function renderInvestigation() {
    const sig = S.signals.find((s) => s.id === focus)
    const inv = (sig && sig.investigationId && S.investigations.find((i) => i.id === sig.investigationId)) || (followLatest ? S.investigations[0] : null)
    if (!inv) {
      set('investigation', `<h2>Investigation</h2><p class="empty">No paid work for this signal. The agent spends credits only after the coordinator decides <b>INVESTIGATE</b>.</p>`
)
      return
    }
    const a = inv.artifact
    const spendPct = inv.maxBudgetUsd ? Math.min(100, (inv.spentUsd / inv.maxBudgetUsd) * 100) : 0
    const estPct = inv.maxBudgetUsd ? Math.min(100, (inv.estimateUsd / inv.maxBudgetUsd) * 100) : 0
    const delta = inv.balanceBefore !== null && inv.balanceAfter !== null ? inv.balanceBefore - inv.balanceAfter : null
    const workers = inv.workers
      .map((w) => `<li><span class="pip ${w.status}"></span><div><div class="who">${esc(w.id)} <span class="badge ${w.status}">${w.status}</span></div><div class="role">${esc(w.role)} · ${esc(w.model)}${w.error ? ` · <span style="color:var(--bad)">${esc(w.error)}</span>` : ''}</div></div><div class="money">bid ≤ ${usd(w.estimateUsd, 4)}<br><b>${w.costUsd ? usd(w.costUsd, 6) : '—'}</b></div></li>`)
      .join('')
    const evidence = inv.evidence.length
      ? `<ul class="ev">${inv.evidence.map((e) => `<li><span class="ref">${esc(e.ref)}</span>${esc(e.name)} <span class="badge ${e.ok ? 'ok' : 'bad'}">${e.ok ? e.kind : 'failed'}</span> ${safeUrl(e.url) ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">open</a>` : ''}</li>`).join('')}</ul>`
      : '<p class="empty">Not fetched yet.</p>'
    const line = (l) => `<li><span class="ref">${esc(l.ref)}</span>${esc(l.finding)}<div class="src">${esc(l.source)} ${safeUrl(l.url) ? `· <a href="${esc(l.url)}" target="_blank" rel="noopener">source</a>` : ''}</div></li>`
    const artifact = a
      ? `<div class="verdict ${a.status}">
          <div class="head"><span class="st">${a.status.replace('_', ' ').toUpperCase()}</span>
            <div class="conf"><div class="bar"><i style="width:${a.confidence * 100}%"></i></div></div>
            <span class="mono">${pct(a.confidence)} confidence</span></div>
          <p style="margin:10px 0 0"><b>${esc(a.claim)}</b></p>
          <ul class="finding">${a.finding.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        </div>
        <div class="two">
          <div class="for"><h3>Evidence for</h3><ul class="ev">${a.evidenceFor.map(line).join('') || '<li class="muted">none</li>'}</ul></div>
          <div class="against"><h3>Evidence against</h3><ul class="ev">${a.evidenceAgainst.map(line).join('') || '<li class="muted">none</li>'}</ul></div>
        </div>
        <div class="two" style="margin-top:14px">
          <div><h3>Unknowns</h3><ul class="finding" style="margin:0">${a.unknowns.map((u) => `<li>${esc(u)}</li>`).join('') || '<li class="muted">none stated</li>'}</ul></div>
          <div><h3>Origin & action</h3><p style="margin:0;font-size:.9rem"><span class="ref">${esc(a.origin.ref)}</span>${esc(a.origin.source)} · ${time(a.origin.firstSeen)}<br>Recommended: <b>${esc(a.recommendedAction)}</b>${inv.alert ? `<br><span class="muted">Alert: ${esc(inv.alert.detail)}</span>` : ''}</p></div>
        </div>
        ${det(`why-${inv.id}`, 'Verifier rationale and acceptance checks', `<p style="font-size:.9rem">${esc(a.rationale)}</p>${inv.acceptance ? `<ul class="checks">${inv.acceptance.checks.map((c) => `<li><span class="${c.ok ? 'y' : 'x'}">${c.ok ? '✓' : '✗'}</span><span>${esc(c.label)}<span class="d">${esc(c.detail)}</span></span></li>`).join('')}</ul>` : ''}`)}`
      : inv.error
        ? `<p class="empty" style="color:var(--bad)">${esc(inv.error)}</p>`
        : `<p class="empty">Working… the artifact appears when the verifier finishes.</p>`
    set('investigation', `
      <h2>Investigation <span class="badge ${inv.status}">${esc(inv.status)}</span>${inv.demo ? '<span class="badge warn">demo fixture</span>' : ''}<span class="right mono" style="font-size:.75rem">${esc(inv.id)} · ${time(inv.createdAt)}</span></h2>
      <div class="budgetline">
        <span>allocated <b>${usd(inv.maxBudgetUsd, 4)}</b></span>
        <span>planned worst case <b>${usd(inv.estimateUsd, 4)}</b></span>
        <span>spent <b style="color:var(--accent)">${usd(inv.spentUsd, 6)}</b></span>
        <span>balance <b>${usd(inv.balanceBefore, 6)}</b> → <b>${usd(inv.balanceAfter, 6)}</b>${delta !== null ? ` <span class="muted">(Δ ${usd(delta, 6)})</span>` : ''}</span>
      </div>
      <div class="bar" style="height:10px;position:relative;margin-bottom:14px" title="spent vs allocation"><i style="width:${spendPct}%"></i><span style="position:absolute;top:-3px;left:${estPct}%;width:2px;height:16px;background:var(--muted)" title="planned worst case"></span></div>
      <ul class="workers">${workers}</ul>
      ${artifact}
      ${det(`ev-${inv.id}`, `Evidence fetched for free (${inv.evidence.filter((e) => e.ok).length} documents)`, evidence)}
      ${det(`contract-${inv.id}`, 'The contract', `<p style="font-size:.9rem"><b>${esc(inv.contract.task)}</b><br>deadline ${inv.contract.deadlineSec}s · key ${esc(inv.keyPrefix || '—')}…</p><ul class="finding">${inv.contract.successConditions.map((c) => `<li>${esc(c)}</li>`).join('')}</ul><p><a href="/api/investigations/${esc(inv.id)}?download=1">Download the artifact (JSON)</a></p>`)}`
)
  }

  // ── log, spend, background, sources ─────────────────────────────────────────────────────────
  function renderLog() {
    set('log', `<h2>Agent activity <span class="right muted" style="text-transform:none;letter-spacing:0">${S.stats.scans} scans · ${S.stats.itemsRead} items read</span></h2>
      <ul class="log">${S.log.map((l) => `<li><div><span class="t">${time(l.at)}</span> <span class="a ${l.actor}">${l.actor}</span></div><div class="msg">${esc(l.msg)}</div></li>`).join('')}</ul>`
)
  }

  function renderSpend() {
    const rows = S.spend
      .map((s) => `<tr><td class="num">${time(s.at)}</td><td>${esc(s.workerId)}<div class="muted" style="font-size:.74rem">${esc(s.investigationId)}</div></td><td>${esc(s.model)}</td><td class="num">${s.promptTokens}+${s.completionTokens}</td><td class="num">${usd(s.costUsd, 6)}</td><td class="num">${s.balanceBefore !== null ? s.balanceBefore.toFixed(6) : '—'} → ${s.balanceAfter !== null ? s.balanceAfter.toFixed(6) : '—'}</td></tr>`)
      .join('')
    set('spend', `<h2>Spend ledger</h2><p class="muted" style="font-size:.8rem;margin:-6px 0 8px">Every paid call, with the cost the Orbio gateway reported and the account balance read right after it. Orbio holds funds when a call starts and settles a few seconds later, so one row's balance can include another call's hold; each investigation's total balance change matches its metered cost.</p>
      ${rows ? `<div class="scroll"><table><thead><tr><th>Time</th><th>Worker</th><th>Model</th><th style="text-align:right">Tokens</th><th style="text-align:right">Cost</th><th style="text-align:right">Balance read</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty">No paid calls yet. Watching, embedding and clustering cost nothing.</p>'}`
)
  }

  function renderBackground() {
    set('background', `<h2>Background: real feeds, off mission</h2>
      ${S.background.length ? `<ul class="bg">${S.background.map((b) => `<li><span class="s">${b.decision.score.toFixed(2)}</span><span><span class="clamp">${esc(b.claim)}</span><div class="m">${b.decision.metrics.mentions} mentions · ${b.decision.metrics.uniqueSources} sources · IGNORE, $0</div></span></li>`).join('')}</ul>` : '<p class="empty">No scans yet.</p>'}
      <p class="muted" style="font-size:.78rem;margin:10px 0 0">The strongest clusters in live public feeds right now. None mention ${esc(S.mission.entity)}, so the agent spends nothing on them.</p>`
)
  }

  function renderSources() {
    set('sources', `<h2>Sources</h2>
      ${S.sources.length ? `<ul class="bg">${S.sources.map((s) => `<li><span class="badge ${s.ok ? 'ok' : 'bad'}">${s.ok ? 'ok' : 'fail'}</span><span>${esc(s.name)}<div class="m">${s.items} items${s.cached ? ' · cached' : ''} · ${time(s.at)}${s.error ? ` · ${esc(s.error)}` : ''}</div></span></li>`).join('')}</ul>` : '<p class="empty">The first scan starts a few seconds after boot.</p>'}
      <p class="muted" style="font-size:.78rem;margin:10px 0 0">Last scan ${time(S.stats.lastScanAt)}. ${S.schedule.enabled ? `Scheduled every ${S.schedule.scanEveryMin} min` : 'Schedule off'}; "Scan now" runs one immediately.</p>`
)
  }

  function render() {
    if (!S) return
    renderPhase()
    renderWallet()
    renderSignal()
    renderInvestigation()
    renderLog()
    renderSpend()
    renderBackground()
    renderSources()
  }

  async function refresh() {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' })
      S = await res.json()
      render()
    } catch {
      $('phase').textContent = 'OFFLINE'
    }
  }

  refresh()
  setInterval(refresh, 1500)
})()
