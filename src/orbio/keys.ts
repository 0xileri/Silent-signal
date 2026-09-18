// The agent's Orbio account through the MCP: read the balance, read the key, mint (which also
// rotates), revoke. An Orbio account has exactly one key. The secret is returned once, by
// orbio_create_key; the agent keeps it in memory only, never on disk or in a log, and a restart
// simply means minting a new one (which retires the old).
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { connectOrbio } from './mcp.js'

interface Usd {
  usd: number
}

export interface Balance {
  balanceUsd: number
  spentUsd: number
  accruedUsd: number
  purchasedUsd: number
  at: string
}

export interface KeyStatus {
  hasKey: boolean
  prefix: string | null
  createdAt: string | null
  lastUsedAt: string | null
  baseUrl: string
}

export interface HeldKey {
  secret: string
  prefix: string
  baseUrl: string
  claimedAt: string
}

let client: Client | undefined

/** One MCP session, reopened if it drops. */
async function orbio(): Promise<Client> {
  client ??= await connectOrbio()
  return client
}

async function callTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  let attempt = 0
  for (;;) {
    try {
      const result = await (await orbio()).callTool({ name, arguments: args })
      const blocks = (result.content ?? []) as { type: string; text?: string }[]
      const text = blocks.find((block) => block.type === 'text')?.text
      if (result.isError) throw new Error(`${name} failed: ${text ?? 'no details'}`)
      if (result.structuredContent) return result.structuredContent as T
      if (text) return JSON.parse(text) as T
      throw new Error(`${name} returned nothing`)
    } catch (err) {
      // A dropped session is retried once on a fresh connection; a tool error is not.
      if (attempt++ > 0 || (err instanceof Error && err.message.startsWith(name))) throw err
      await client?.close().catch(() => {})
      client = undefined
    }
  }
}

export async function getBalance(): Promise<Balance> {
  const b = await callTool<{ balance: Usd; spent: Usd; accrued: Usd; purchased?: Usd }>('orbio_get_balance')
  return {
    balanceUsd: b.balance.usd,
    spentUsd: b.spent.usd,
    accruedUsd: b.accrued.usd,
    purchasedUsd: b.purchased?.usd ?? 0,
    at: new Date().toISOString(),
  }
}

export async function getKeyStatus(): Promise<KeyStatus> {
  const s = await callTool<KeyStatus>('orbio_get_key_status')
  return {
    hasKey: s.hasKey,
    prefix: s.prefix ?? null,
    createdAt: s.createdAt ?? null,
    lastUsedAt: s.lastUsedAt ?? null,
    baseUrl: s.baseUrl,
  }
}

/** Mints the account's key; an existing key is retired in the same call. */
export async function createKey(label: string): Promise<{ key: HeldKey; replaced: boolean }> {
  const minted = await callTool<{ key: string; prefix: string; baseUrl: string; replaced: boolean }>('orbio_create_key', {
    label,
  })
  return {
    key: { secret: minted.key, prefix: minted.prefix, baseUrl: minted.baseUrl, claimedAt: new Date().toISOString() },
    replaced: minted.replaced,
  }
}

export async function revokeKey(): Promise<boolean> {
  const { revoked } = await callTool<{ revoked: boolean }>('orbio_revoke_key')
  return revoked
}

/**
 * Asks the gateway whether a key still works. GET /key is free, so proving a retired key is dead
 * costs nothing.
 */
export async function keyAnswers(key: Pick<HeldKey, 'secret' | 'baseUrl'>): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(`${key.baseUrl}/key`, {
    headers: { authorization: `Bearer ${key.secret}` },
    signal: AbortSignal.timeout(15_000),
  })
  return { ok: res.ok, status: res.status }
}
