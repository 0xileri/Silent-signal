// Paid inference, on the agent's own key, through the Orbio gateway (OpenAI-compatible). Every call
// goes through `meteredCall`, which refuses to start a call whose worst case would break the
// investigation's budget, and prices the finished call from its real token usage.
import OpenAI from 'openai'
import type { HeldKey } from './keys.js'

export const GATEWAY_URL = 'https://api.orbio.so/api/v1'

export interface Price {
  prompt: number
  completion: number
}

export class BudgetError extends Error {}
export class KeyRejectedError extends Error {}

const prices = new Map<string, Promise<Price>>()

/** Per-token prices from the gateway's public model list: what Orbio charges for each token. */
export function priceOf(model: string): Promise<Price> {
  let price = prices.get(model)
  if (!price) {
    price = fetch(`${GATEWAY_URL}/models`, { signal: AbortSignal.timeout(20_000) })
      .then((res) => res.json() as Promise<{ data: { id: string; pricing: Record<string, string> }[] }>)
      .then(({ data }) => {
        const pricing = data.find((m) => m.id === model)?.pricing
        if (!pricing) throw new Error(`${model} is not on the Orbio gateway`)
        return { prompt: Number(pricing.prompt), completion: Number(pricing.completion) }
      })
    price.catch(() => prices.delete(model))
    prices.set(model, price)
  }
  return price
}

/** A deliberate over-estimate: about 3 characters per token, where English averages nearer 4. */
export const tokensIn = (text: string) => Math.ceil(text.length / 3) + 20

export const usdOf = (price: Price, promptTokens: number, completionTokens: number) =>
  promptTokens * price.prompt + completionTokens * price.completion

export interface Meter {
  limitUsd: number
  spentUsd: number
}

export interface CallResult<T> {
  data: T
  model: string
  promptTokens: number
  completionTokens: number
  costUsd: number
  costSource: 'gateway' | 'price-list'
}

export async function meteredCall<T>(opts: {
  key: HeldKey
  model: string
  system: string
  user: string
  schemaName: string
  schema: Record<string, unknown>
  maxTokens: number
  meter: Meter
  parse: (value: unknown) => T
  /** Called as soon as the call is paid for, before its answer is parsed, so no spend goes unrecorded. */
  onSpend: (spend: Omit<CallResult<T>, 'data'>) => void
}): Promise<CallResult<T>> {
  const price = await priceOf(opts.model)
  const worstCase = usdOf(price, tokensIn(opts.system + opts.user), opts.maxTokens)
  if (opts.meter.spentUsd + worstCase > opts.meter.limitUsd) {
    throw new BudgetError(
      `worst case $${worstCase.toFixed(4)} would take the investigation past its $${opts.meter.limitUsd.toFixed(4)} budget`,
    )
  }
  const gateway = new OpenAI({ apiKey: opts.key.secret, baseURL: opts.key.baseUrl, maxRetries: 1, timeout: 90_000 })
  let res: OpenAI.Chat.Completions.ChatCompletion
  try {
    res = await gateway.chat.completions.create({
      model: opts.model,
      max_tokens: opts.maxTokens,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: opts.schemaName, strict: true, schema: opts.schema },
      },
    })
  } catch (err) {
    if (err instanceof OpenAI.APIError && err.status === 401) throw new KeyRejectedError('the gateway rejected the key')
    throw err
  }
  const usage = res.usage as (OpenAI.CompletionUsage & { cost?: number }) | undefined
  const promptTokens = usage?.prompt_tokens ?? 0
  const completionTokens = usage?.completion_tokens ?? 0
  const reported = typeof usage?.cost === 'number' ? usage.cost : undefined
  const costUsd = round6(reported ?? usdOf(price, promptTokens, completionTokens))
  opts.meter.spentUsd = round6(opts.meter.spentUsd + costUsd)
  const spend = {
    model: res.model || opts.model,
    promptTokens,
    completionTokens,
    costUsd,
    costSource: reported === undefined ? ('price-list' as const) : ('gateway' as const),
  }
  opts.onSpend(spend)
  const content = res.choices[0]?.message.content ?? ''
  // Structured output should be bare JSON; tolerate a model wrapping it in prose or fences.
  const json = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1))
  return { data: opts.parse(json), ...spend }
}

export const round6 = (n: number) => Math.round(n * 1e6) / 1e6
