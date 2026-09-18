// The key lifecycle, live on Orbio, with nothing assumed: balance → mint → status → one tiny paid
// call → balance → rotate (the old key must stop) → revoke. Spends a fraction of a cent. The
// secret is only ever held in memory.
import '../env.js'
import OpenAI from 'openai'
import { createKey, getBalance, getKeyStatus, keyAnswers, revokeKey, type HeldKey } from '../orbio/keys.js'
import { priceOf } from '../orbio/gateway.js'
import { MODELS } from '../config.js'

const usd = (n: number) => `$${n.toFixed(6)}`
const step = (label: string, detail: string) => console.log(`${label.padEnd(26)} ${detail}`)

async function ping(key: HeldKey) {
  const res = await new OpenAI({ apiKey: key.secret, baseURL: key.baseUrl, maxRetries: 0 }).chat.completions.create({
    model: MODELS.worker,
    messages: [{ role: 'user', content: 'Reply with exactly one word: ready' }],
    max_tokens: 5,
  })
  return { text: res.choices[0]?.message.content?.trim() ?? '', usage: res.usage as OpenAI.CompletionUsage & { cost?: number } }
}

const start = await getBalance()
step('orbio_get_balance', `${usd(start.balanceUsd)} spendable, ${usd(start.spentUsd)} spent so far`)

const first = await createKey('silent-signal-lifecycle')
step('orbio_create_key', `${first.key.prefix}… (replaced an existing key: ${first.replaced})`)
const status = await getKeyStatus()
step('orbio_get_key_status', `hasKey ${status.hasKey}, prefix ${status.prefix}…, created ${status.createdAt}`)
step('GET /key (free)', `HTTP ${(await keyAnswers(first.key)).status}`)

const reply = await ping(first.key)
const price = await priceOf(MODELS.worker)
const metered = reply.usage.prompt_tokens * price.prompt + reply.usage.completion_tokens * price.completion
step(`paid call (${MODELS.worker})`, `"${reply.text}" · ${reply.usage.prompt_tokens}+${reply.usage.completion_tokens} tokens · ${usd(metered)} at list price${typeof reply.usage.cost === 'number' ? ` · gateway reports ${usd(reply.usage.cost)}` : ''}`)
let after = await getBalance()
for (let i = 0; i < 5 && after.balanceUsd === start.balanceUsd; i++) {
  await new Promise((resolve) => setTimeout(resolve, 1500))
  after = await getBalance()
}
step('orbio_get_balance', `${usd(after.balanceUsd)} (Δ ${usd(start.balanceUsd - after.balanceUsd)}), spent ${usd(after.spentUsd)}`)

const second = await createKey('silent-signal-lifecycle')
step('orbio_create_key (rotate)', `${first.key.prefix}… → ${second.key.prefix}… (replaced: ${second.replaced})`)
const [oldKey, newKey] = await Promise.all([keyAnswers(first.key), keyAnswers(second.key)])
step('old key, GET /key', `HTTP ${oldKey.status} ${oldKey.ok ? 'STILL ANSWERS (unexpected)' : '(dead)'}`)
step('new key, GET /key', `HTTP ${newKey.status}`)
const oldPaid = await ping(first.key).then(() => 'STILL ANSWERS (unexpected)', (err) => `rejected (${err.status ?? err.message})`)
step('old key, paid call', oldPaid)
const rotated = await getBalance()
step('orbio_get_balance', `${usd(rotated.balanceUsd)} (rotation moved ${usd(after.balanceUsd - rotated.balanceUsd)})`)

step('orbio_revoke_key', `revoked: ${await revokeKey()}`)
step('new key, GET /key', `HTTP ${(await keyAnswers(second.key)).status}`)
const end = await getKeyStatus()
step('orbio_get_key_status', `hasKey ${end.hasKey}`)
process.exit(0)
