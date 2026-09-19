// The mission and every threshold the agent acts on, in one place. Everything can be overridden
// with environment variables; the defaults are the ones the demo runs with.
import './env.js'

const num = (name: string, fallback: number) => {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : Number(value)
}
const list = (name: string, fallback: string[]) =>
  process.env[name] ? process.env[name]!.split(',').map((s) => s.trim()).filter(Boolean) : fallback

export const PORT = num('PORT', 3000)
export const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '')

/**
 * What the agent protects. The default mission is the demo's fictional "Project X", whose status
 * page and announcements this app serves itself (see src/demo/). Point it at a real project by
 * setting the entity, its terms and its official pages.
 */
export const MISSION = {
  entity: process.env.MISSION_ENTITY ?? 'Project X',
  statement: process.env.MISSION_STATEMENT ?? 'Protect Project X from emerging information risks',
  terms: list('MISSION_TERMS', ['project x', 'projectx', '$prjx']).map((t) => t.toLowerCase()),
  officialSources: process.env.MISSION_OFFICIAL_URLS
    ? list('MISSION_OFFICIAL_URLS', []).map((url) => ({ name: new URL(url).hostname, url }))
    : [
        { name: 'Project X status page', url: `${PUBLIC_URL}/demo/projectx/status` },
        { name: 'Project X announcements', url: `${PUBLIC_URL}/demo/projectx/announcements` },
      ],
}

/**
 * The spend policy. The operator hands the agent a budget out of the real Orbio balance; the
 * agent keeps a reserve it never touches, caps what one investigation may cost, and never spends
 * more than the account actually holds.
 */
export const POLICY = {
  budgetUsd: num('MISSION_BUDGET_USD', 2),
  reserveShare: num('RESERVE_SHARE', 0.2),
  maxPerInvestigationShare: num('MAX_PER_INVESTIGATION_SHARE', 0.15),
  /** One call costing more than this revokes the key on the spot. */
  anomalyCallUsd: num('ANOMALY_CALL_USD', 0.05),
  /** A fresh key after every investigation, so a leaked worker key is already dead. */
  rotateAfterInvestigation: process.env.ROTATE_AFTER_INVESTIGATION !== 'off',
  maxConcurrentInvestigations: 1,
  deadlineSec: num('INVESTIGATION_DEADLINE_SEC', 120),
  /** A claim this close to one investigated in the last day is not paid for twice. */
  cooldownHours: num('COOLDOWN_HOURS', 24),
  cooldownSimilarity: num('COOLDOWN_SIMILARITY', 0.8),
}

/** The verifier is appointed; tracers and cross-checkers are hired by auction (src/agent/market.ts). */
export const MODELS = {
  verifier: process.env.VERIFIER_MODEL ?? 'anthropic/claude-sonnet-5',
}

/** The free, local part: clustering and the signal score (see src/watcher/score.ts). */
export const SIGNAL = {
  clusterSimilarity: num('CLUSTER_SIMILARITY', 0.6),
  windowMin: 15,
  watchAt: num('WATCH_THRESHOLD', 0.55),
  investigateAt: num('INVESTIGATE_THRESHOLD', 0.72),
  weights: { velocity: 0.3, diversity: 0.25, size: 0.2, severity: 0.15, novelty: 0.1 },
  /** Mentions in the last 15 minutes that count as full velocity. */
  velocityFull: 8,
  /** Independent sources beyond the first that count as full diversity. */
  diversityFull: 3,
  /** Mentions beyond the first that count as full size. */
  sizeFull: 8,
  retainHours: 72,
}

export const SCHEDULE = {
  enabled: process.env.AGENT_SCHEDULE !== 'off',
  scanEveryMin: num('SCAN_INTERVAL_MIN', 15),
  feedCacheMin: num('FEED_CACHE_MIN', 10),
  demoWaveDelaySec: num('DEMO_WAVE_DELAY_SEC', 12),
  /** Public "Run demo" presses: at most one per this many seconds, and this many a day. */
  demoCooldownSec: num('DEMO_COOLDOWN_SEC', 150),
  publicDemosPerDay: num('PUBLIC_DEMOS_PER_DAY', 12),
}

/**
 * Self-refuel from the agent's treasury on Robinhood Chain. When the runway (investigations left
 * before the reserve) drops below the trigger, the agent buys CREDIT from Orbio's order book and
 * activates it into the account it spends from. It only buys at a discount, within a daily cap.
 */
export const REFUEL = {
  enabled: process.env.REFUEL !== 'off',
  whenRunwayBelow: num('REFUEL_WHEN_RUNWAY_BELOW', 3),
  usdg: num('REFUEL_USDG', 2),
  maxPrice: num('REFUEL_MAX_PRICE', 0.95),
  slippage: num('REFUEL_SLIPPAGE', 0.01),
  maxUsdgPerDay: num('REFUEL_MAX_USDG_PER_DAY', 6),
  /** Where activated CREDIT goes. Default: the wallet orbio_get_balance lists for the account. */
  beneficiary: process.env.REFUEL_BENEFICIARY,
  confirmTimeoutSec: num('REFUEL_CONFIRM_SEC', 180),
}

export const TELEGRAM = {
  token: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
}

export const ADMIN_TOKEN = process.env.ADMIN_TOKEN
export const REPO_URL = process.env.REPO_URL
