// The alert: a compact Telegram message when a bot is configured, otherwise the dashboard only.
import { MISSION, PUBLIC_URL, TELEGRAM } from '../config.js'
import type { Investigation } from '../core/types.js'

const STATUS_LABEL = {
  supported: 'SUPPORTED',
  partially_supported: 'PARTIALLY SUPPORTED',
  unsupported: 'UNSUPPORTED',
  unclear: 'UNCLEAR',
} as const

export function alertText(inv: Investigation): string {
  const a = inv.artifact!
  const t = inv.trigger
  const spent = inv.balanceBefore !== null && inv.balanceAfter !== null ? inv.balanceBefore - inv.balanceAfter : inv.spentUsd
  return [
    `⚠ HUNCH · ${MISSION.entity}${inv.demo ? ' (demo fixture)' : ''}`,
    '',
    `Claim: ${a.claim}`,
    `Status: ${STATUS_LABEL[a.status]} · confidence ${Math.round(a.confidence * 100)}%`,
    '',
    'Why it triggered:',
    `${t.mentions} mentions · ${t.uniqueSources} sources · ${t.last15} in the last 15 min · score ${t.score.toFixed(2)}`,
    '',
    'Finding:',
    ...a.finding.map((line) => `• ${line}`),
    ...(a.unknowns.length ? ['', `Unknown: ${a.unknowns.slice(0, 2).join('; ')}`] : []),
    '',
    `Recommended: ${a.recommendedAction}`,
    `Credits spent: $${spent.toFixed(4)} · balance $${inv.balanceAfter?.toFixed(4) ?? '?'}`,
    `${PUBLIC_URL}/#${inv.id}`,
  ].join('\n')
}

export async function sendAlert(inv: Investigation): Promise<NonNullable<Investigation['alert']>> {
  if (!TELEGRAM.token || !TELEGRAM.chatId) {
    return { channel: 'dashboard', sent: true, detail: 'Telegram not configured; shown on the dashboard' }
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM.chatId, text: alertText(inv), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await res.json()) as { ok: boolean; description?: string }
    return body.ok
      ? { channel: 'telegram', sent: true, detail: 'sent to Telegram' }
      : { channel: 'telegram', sent: false, detail: body.description ?? `HTTP ${res.status}` }
  } catch (err) {
    return { channel: 'telegram', sent: false, detail: err instanceof Error ? err.message : String(err) }
  }
}
