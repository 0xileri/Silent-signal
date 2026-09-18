<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/logo-dark.svg">
    <img alt="Hunch" src="brand/logo-light.svg" width="260">
  </picture>
</h1>

**Free hunches. Paid proof.**

**Live:** [hunch-agent.up.railway.app](https://hunch-agent.up.railway.app). Press **Run demo fixture** and watch it decide.

Hunch is an agent with a finite inference budget that decides when information is worth paying for. It watches public sources and scores emerging narratives with local embeddings, for free: that score is its hunch. It spends its own [Orbio](https://orbio.so) inference budget on proof only when a hunch crosses a risk threshold and the budget allows it. When it spends, a coordinator funds a bounded investigation: two workers and a verifier produce an evidence-backed artifact, and every call is recorded with its real cost and the real balance.

Built for Orbio Build Week. It is an **autonomous budgeted swarm** that refuels itself from an operator-funded treasury on Robinhood Chain, through Orbio's `buyAndActivate`. Its first live refuel turned 2 USDG into $2.67 of inference, confirmed in `orbio_get_balance` (see [Self-refuel](#self-refuel-from-a-treasury)). It doesn't earn its fuel: nothing here turns completed work into money.

> "The important part is not that AI read Reddit. It's that the agent decided when the information was worth spending money on."

## The loop

```
mission + budget
  → WATCHER      reads RSS feeds, embeds posts locally (all-MiniLM-L6-v2), clusters same-claim posts ... $0
  → SIGNAL       scores each cluster: velocity, source diversity, size, severity, novelty ............ $0
  → COORDINATOR  IGNORE / WATCH / INVESTIGATE, with the budget, reserve, cap and key in view ......... $0
  → FUNDING      allocates a maximum; every paid call must fit its worst case inside what's left
  → MARKET       workers bid their cost at real prices; the best quality per dollar is hired ........ $0
  → WORKERS      source-tracer → evidence fetch (HTTP, $0) → cross-checker ............... paid, on its key
  → VERIFIER     one calibrated finding, then code-level acceptance checks ................. paid, on its key
  → ACCOUNTING   balance before/after from orbio_get_balance; spend ledger; alert; fresh key
  → FUEL         runway short? buy CREDIT on Robinhood Chain from the treasury and activate it
```

The dashboard shows every step live: the state machine, the score and why, each check the coordinator ran, the workers and their bids, the artifact, the spend ledger and the agent's activity log.

## The worker market

The source-tracer and cross-checker jobs are open to a small market of workers on different models. Before an investigation is funded, every worker bids its expected cost for this job at the gateway's real per-token prices. The coordinator hires the best **quality per dollar** (reputation ÷ bid) among workers whose reputation clears a 0.75 floor. The verifier is appointed, not auctioned: the judge shouldn't be whoever bids lowest.

| Role | Workers | Price per million tokens (in / out) |
|---|---|---|
| Source-tracer, cross-checker | Claude Haiku 4.5 | $1.00 / $5.00 |
| | Gemini 2.5 Flash-Lite | $0.10 / $0.40 |
| | Mistral Small 3.2 | $0.09 / $0.25 |
| Verifier (appointed) | Claude Sonnet 5 | $2.00 / $10.00 |

**Reputation is earned, and code grades it, not a model:**

- **Source-tracer:** did it name the true earliest post (40%)? Are its citations real posts (35%)? Does each sub-claim start where it first appears (25%)?
- **Cross-checker:** are its citations fetched documents (30%)? Do its quotes appear word for word in the documents it cites (50%)? Did it assess every sub-claim (20%)?
- **Verifier:** the share of the artifact's acceptance checks that passed.
- **Failures:** no usable answer scores 0. An answer cut off at its token cap, or off-schema, gets one retry with a bigger cap, and the grade is docked 15%.
- **Reputation:** the average grade, starting from 0.8 counted as two jobs.
- **Trial jobs:** a worker with no record gets one trial job if its bid is within 5× of the best-value bid, so every affordable worker gets tested instead of the cheapest winning forever unexamined.

**Measured on the demo fixture** (`npm run market:trial`, one job each, $0.0094 in total):

| Worker | Grade | Cost | Time |
|---|---|---|---|
| tracer: Haiku / Flash-Lite / Mistral | 1.00 / 1.00 / 1.00 | $0.0029 / $0.0004 / $0.0002 | 5.8s / 3.4s / 9.1s |
| cross-checker: Haiku / Flash-Lite / Mistral | 1.00 / **0.70** / 1.00 | $0.0052 / $0.0004 / $0.0003 | 5.7s / 3.0s / 14.4s |

Flash-Lite's cross-check looked fine, but half its quotes don't appear in the documents it cites. Only the grade shows that.

**In live runs:**

- **First run:** Mistral won both auctions and graded 1.00, and the investigation cost **$0.0150 instead of $0.025**, with the same verdict.
- **Second run:** Mistral's tracer answer ran past its token cap and scored 0, dropping it to 0.65, below the floor, so it was excluded from the next auction.
- **Third run:** Flash-Lite got its trial as cross-checker, needed a retry, and graded 0.85.

No worker is paid. Bids are cost estimates, and every cent is the agent's own inference spend.

## Self-refuel from a treasury

The agent has its own wallet on Robinhood Chain (chain 4663): the treasury. The operator funds it with USDG and a little ETH for gas. When the agent's runway (the investigations it can still afford before its reserve) drops below 3, it refuels itself through Orbio's published CREDIT protocol ([orbio.so/protocol/agents](https://www.orbio.so/protocol/agents)):

1. `Exchange.getQuote(usdgIn, MAX_FILLS)`: price the CREDIT order book. The agent refuses to buy above $0.95 per CREDIT. The book has been selling at **$0.75**, so $2 of USDG buys 2.67 CREDIT, which is $2.67 of Orbio inference.
2. `USDG.approve(exchange, exactAmount)`: only what this purchase can spend, never an unlimited allowance.
3. `Exchange.buyAndActivate(usdgIn, minCreditOut, beneficiary, maxFills)`: buy CREDIT and burn it into AI balance in one transaction, with 1% slippage protection. The beneficiary is the wallet `orbio_get_balance` lists for the account the agent spends from.
4. Read the CREDIT contract's `Activated` event from the receipt, then wait until `orbio_get_balance` shows the new money. Balance plus spent, minus $ORBIO accrual, only rises when money comes in. Only then does the refuel count toward the budget.

**Limits:**
- 2 USDG per refuel, at most 6 USDG a day
- no retry within an hour of a failure
- nothing while the operator has the agent paused

The dashboard shows the treasury, the policy and every refuel with its transaction. Operators can also press **Refuel now**.

**Measured, first live refuel (2026-09-18):**

| Step | Result |
|---|---|
| Quote | 2 USDG → 2.666666 CREDIT at $0.75 (1 fill, 0% fee) |
| `approve` | exactly 2 USDG: [0xfa71…d156](https://robinhoodchain.blockscout.com/tx/0xfa710693e9ea74f7b087972d2842256054cd03ac615d97c58159d56fa472d156) |
| `buyAndActivate` | 2 USDG → 2.666666 CREDIT activated, activation #214: [0xea34…7bca](https://robinhoodchain.blockscout.com/tx/0xea34a9cab1e4a5e48adeb7c56f09f044b203a71cc7d30ced16c7b9623cbb7bca) |
| Gas | 0.0000152 ETH for both transactions |
| `orbio_get_balance` | $49.779849 → **$52.446515** (+$2.666666), seconds after the transaction |
| Mission budget | $2.00 → $4.67 |

The activation raised `balance` directly, while `purchased` and `deposited` stayed at 0. That's why the confirmation uses balance + spent − accrued rather than trusting any one field.

**What this is:** the agent decides when it needs fuel, buys it on-chain and activates it for itself. The treasury's money comes from the operator; the agent doesn't earn it. Per the spec, that makes this self-refuel from an operator-funded treasury, not an agent that pays for itself.

## The agent owns its key

The agent signs in to the Orbio MCP (`https://www.orbio.so/api/mcp`) as its own OAuth client and manages its key with the real MCP tools:

| When | What it does | Orbio |
|---|---|---|
| Start | Reads the balance, mints its key, reads the key status | `orbio_get_balance`, `orbio_create_key`, `orbio_get_key_status` |
| Every scan and every paid call | Reads the real balance, and checks the account's key is still its own; if something else minted or revoked it, the agent claims a fresh one | `orbio_get_balance`, `orbio_get_key_status` |
| After every investigation | Rotates: mints a fresh key (Orbio retires the old one in the same call), then proves the old key is dead with a free `GET /api/v1/key` | `orbio_create_key` |
| Operator presses Revoke, or one call costs over $0.05 | Revokes. The agent then refuses paid work, even across restarts, until the operator claims a key again | `orbio_revoke_key` |
| Shutdown and restart | Tries to revoke on shutdown. If the host kills the process first (Railway does on redeploy), the next start's mint retires the old key in the same call, so no stale key outlives a restart | `orbio_revoke_key`, `orbio_create_key` |

The secret only ever lives in the agent's memory. It is never written to disk, logged or sent to the browser.

## The budget policy

The operator gives the agent a mission budget out of the real Orbio balance (default $2.00):

- **Reserve:** 20% of the budget is never spent.
- **Cap:** at most 15% of the budget per investigation.
- **Worst-case check:** before each call, the agent prices the prompt at ~3 characters per token plus the full `max_tokens` at the gateway's published per-token prices. The call only goes ahead if that worst case fits in what's left of the allocation.
- **Actual cost:** the cost the gateway reports in `usage.cost`, which matched list price in every call so far. The investigation's balance before and after comes from `orbio_get_balance`.
- **Never twice:** a claim is not paid for again if it's ≥ 80% similar to one investigated in the last 24 hours.
- **At most one investigation at a time.**

Decision thresholds on the signal score: below 0.55 IGNORE, 0.55 to 0.72 WATCH (re-checked every scan, $0), from 0.72 INVESTIGATE if every check passes. Otherwise it WATCHes and says which check failed ("reserve protected", "the agent holds no key", "already investigated").

```
score = 0.30 velocity + 0.25 source diversity + 0.20 cluster size + 0.15 severity + 0.10 novelty
velocity  = mentions in the last 15 min / 8        diversity = (independent sources − 1) / 3
size      = (mentions − 1) / 8                      severity  = keyword tiers (exploit/drained > halted/frozen > stuck/pending)
novelty   = 1 − similarity to anything investigated in the last 24 h           (each clamped to 0..1)
```

A cluster must also mention the mission's entity. Everything else is scored but ignored as "off mission".

## Measured (live, 2026-09-18)

**Key lifecycle** (`npm run key:lifecycle`):

```
orbio_get_balance          $49.991044 spendable
orbio_create_key           sk-orbio-7_sXK0… (replaced an existing key: false)
orbio_get_key_status       hasKey true
GET /key (free)            HTTP 200
paid call (claude-haiku-4.5) "Ready" · 14+4 tokens · $0.000034 at list price · gateway reports $0.000034
orbio_get_balance          $49.991010 (Δ $0.000034)
orbio_create_key (rotate)  sk-orbio-7_sXK0… → sk-orbio-zrRJks… (replaced: true)
old key, GET /key          HTTP 401 (dead)
old key, paid call         rejected (401)
orbio_get_balance          $49.991010 (rotation moved $0.000000)
orbio_revoke_key           revoked: true
orbio_get_key_status       hasKey false
```

**The demo fixture, four runs:**

| | Wave 1 (1 post) | Wave 2 (4 posts, 3 sources) | Wave 3 (9 posts, 4 sources) | Investigation | Verdict |
|---|---|---|---|---|---|
| Run 1 | 0.21 IGNORE | 0.57 WATCH | 0.97 INVESTIGATE | $0.0259 | partially supported, 55% |
| Run 2, key revoked first | 0.21 IGNORE | 0.57 WATCH | 0.97 → **WATCH: "the agent holds no key"**, $0 | after the key was re-claimed, the next scan funded it: $0.0235 | supported, 85%* |
| Run 3 | 0.21 IGNORE | 0.57 WATCH | 0.97 INVESTIGATE | $0.0249 | partially supported, 85% |
| Run 4, deployed on Railway | 0.21 IGNORE | 0.57 WATCH | 0.97 INVESTIGATE | $0.0251 | partially supported, 85% |

In every run, the balance change across the investigation equalled the metered cost to the micro-dollar. A typical investigation: source-tracer (Claude Haiku 4.5) ~$0.0033, cross-checker (Haiku 4.5) ~$0.006, verifier (Claude Sonnet 5) ~$0.016. The planned worst case was ~$0.035 against a $0.30 allocation. After every investigation the agent rotated its key; the old key answered HTTP 401 and the balance didn't move.

\*Run 2 graded only the mild part of the narrative ("withdrawals are delayed"). The verifier is now told to judge the narrative as it spreads, severe sub-claims included. Run 3 is after that change.

**Real feeds**, same session: 115–124 live items from Cointelegraph, Decrypt, Reddit r/CryptoCurrency and Hacker News formed 87 clusters locally. The strongest scored 0.45 and none mentioned the mission, so the agent spent $0 on them.

## The demo fixture (planted, not organic)

The demo needs a signal that shows up on cue, so the app serves a planted narrative about a fictional **"Project X"**:

- nine posts across four fake feeds (a forum, a social feed, a news blog, a chat group), released in three waves about 12 seconds apart. Wave 1 is one "is my withdrawal stuck?" post; wave 3 adds "possible exploit??" and "got drained" posts;
- Project X's own status page and announcements, which say the delays are scheduled hot-wallet maintenance and that there is no security incident.

The watcher reads the fixture's feeds over HTTP like any other source, and the cross-checker fetches the status page like any other evidence. Timestamps are real: a post's time is the moment its wave was released. Fixture posts only cluster with each other, so real posts can't change the demo. Every fixture page says it is planted test data, and the dashboard labels fixture signals **demo fixture**. See `/demo` on a running instance.

## What's real, what's not

| Real | Not real |
|---|---|
| The Orbio balance, key mint/rotate/revoke, every paid call and its cost | The Project X posts, feeds, status page and announcements (a disclosed fixture) |
| Refuels: real USDG, real on-chain `buyAndActivate`, confirmed in `orbio_get_balance` | The agent "earning" its fuel: the treasury is funded by the operator |
| Four live public RSS feeds, scanned every 15 minutes and on "Scan now" | "Real-time" monitoring: it scans on a schedule and on demand |
| Local embeddings, clustering and scores | Worker "bids" are the agent's cost estimates at real prices; no worker is paid |
| The verifier's acceptance checks (code, not a model) | Self-refueling (not built) |

## Running it

Node 22 or newer.

```bash
npm install
npm run orbio:login       # one browser sign-in; saves the agent's Orbio login in .orbio/ (gitignored)
npm start                 # http://localhost:3000
npm run key:lifecycle     # the live key lifecycle above (spends a fraction of a cent)
npm run fixture:check     # the free half offline: fixture wave scores + live feeds, no key, no spend
npm run market:trial      # every worker runs the same fixture job and gets graded (about a cent)
```

Settings are in [.env.example](.env.example): mission, budget, thresholds, models and schedule. Operator controls (Rotate, Revoke, Claim, Pause) need `ADMIN_TOKEN` when it's set. On a public deployment, anyone can press "Run demo fixture" (at most once every 150 seconds), and the budget policy still decides whether to spend. Telegram alerts turn on with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`; without them the alert is shown on the dashboard.

## Code

- `src/watcher/`: `sources.ts` (feeds, cache, parsing), `embed.ts` (MiniLM), `cluster.ts`, `score.ts`
- `src/agent/`: `coordinator.ts` (the state machine, key lifecycle, scans, demo), `budget-policy.ts` (the decision and its checks), `market.ts` (worker pools, auctions, grading, reputation), `investigation.ts` (funding, metering, workers, acceptance), `workers.ts` (prompts and JSON schemas), `evidence.ts`, `alert.ts`
- `src/orbio/`: `mcp.ts` (the agent's OAuth MCP client), `keys.ts` (balance, key status, mint, revoke, free key check), `gateway.ts` (metered calls)
- `src/chain/`: `refuel.ts` (treasury, quote, approve, `buyAndActivate`, the `Activated` receipt) and Orbio's published ABIs
- `src/demo/`: the fixture and Project X's pages
- `src/web/`: the dashboard (`app.js` polls `/api/state`)
- `brand/`: the logo (the rising dots are the demo's three waves: ignore, watch, investigate), as SVG with PNG exports and the link-preview card
- API: `GET /api/state`, `/api/signals`, `/api/investigations/:id`, `/api/spend`; `POST /api/scan`, `/api/demo/run`, `/api/key/{rotate,revoke,claim}`, `/api/agent/{pause,resume}`

Deviations from the original plan, on purpose: one TypeScript process (Hono) serves the dashboard and runs the agent, with no React/Vite build. State is a JSON file instead of SQLite. The clustering threshold is 0.6, not 0.82: the fixture's paraphrases measure 0.49–0.87 apart, and the "exploit" posts split off at 0.82.

## Not built

- **Earning.** The treasury is funded by the operator. A version where paying users or rewards fill the treasury would make the agent truly self-funding.
- Monitoring anything but text.

## Limits

- It finds narratives in the feeds it reads. Four RSS feeds are a small window.
- Severity is keyword-based: a post that says "exploit" raises the score whether or not it's serious. That's why an investigation follows.
- The verifier weighs a project's own status page as what the project says, not as proof. The artifact reports status and confidence, not truth.
