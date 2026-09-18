// Self-refuel, on Robinhood Chain (4663), through Orbio's published Exchange: quote the CREDIT order
// book, approve exactly the USDG the purchase needs, then buyAndActivate, which buys CREDIT and
// burns it into Orbio AI balance for the beneficiary in one transaction. The treasury is the
// agent's own wallet; the operator funds it with USDG and a little ETH for gas.
//
// Contracts and ABIs are Orbio's own (orbio.so/protocol/agents): nothing here is guessed.
import { readFileSync } from 'node:fs'
import {
  createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeFunctionData, fallback, formatEther, formatUnits, http, keccak256,
  pad, parseAbi, type Abi, type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

/**
 * Robinhood's public RPC sits behind Cloudflare and sometimes answers with a bot challenge, so the
 * agent falls back to other public endpoints listed for chain 4663 (checked in sync on 2026-09-19).
 */
const RPC_URLS = (process.env.ROBINHOOD_RPC_URLS ?? 'https://rpc.mainnet.chain.robinhood.com,https://robinhood-rpc.publicnode.com,https://rpc.ordofi.network')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean)
const transport = () => fallback(RPC_URLS.map((url) => http(url, { retryCount: 2, retryDelay: 800, timeout: 20_000 })))

export const ROBINHOOD = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: RPC_URLS } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
})

export const CONTRACTS = {
  exchange: '0x6951ffd32630b05e06f50062aea801625a58ebc0',
  credit: '0xe33322da1380e61e5ae5dfb21e7f62924c73004c',
  usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
} as const

const abi = (name: string): Abi => {
  const raw = JSON.parse(readFileSync(new URL(`./${name}.abi.json`, import.meta.url), 'utf8'))
  return (Array.isArray(raw) ? raw : raw.abi) as Abi
}
const EXCHANGE_ABI = abi('exchange')
const CREDIT_ABI = abi('credit')
const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

export const txUrl = (hash: string) => `${ROBINHOOD.blockExplorers.default.url}/tx/${hash}`
export const addressUrl = (address: string) => `${ROBINHOOD.blockExplorers.default.url}/address/${address}`

const publicClient = createPublicClient({ chain: ROBINHOOD, transport: transport() })

export function treasuryAccount() {
  const key = process.env.AGENT_WALLET_PRIVATE_KEY
  return key && /^0x[0-9a-fA-F]{64}$/.test(key) ? privateKeyToAccount(key as Hex) : null
}

export interface Treasury {
  address: string
  eth: number
  usdg: number
  credit: number
  at: string
}

export async function readTreasury(): Promise<Treasury | null> {
  const account = treasuryAccount()
  if (!account) return null
  const [eth, usdg, credit] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({ address: CONTRACTS.usdg, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
    publicClient.readContract({ address: CONTRACTS.credit, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
  ])
  return {
    address: account.address,
    eth: Number(formatEther(eth)),
    usdg: Number(formatUnits(usdg, 6)),
    credit: Number(formatUnits(credit, 6)),
    at: new Date().toISOString(),
  }
}

export interface Quote {
  usdgIn: bigint
  creditOut: bigint
  usdgSpent: bigint
  feeAtoms: bigint
  fills: bigint
  reason: number
  maxFills: bigint
  /** USDG paid per CREDIT, fees included. */
  price: number
}

export async function quote(usdgIn: bigint): Promise<Quote> {
  const maxFills = (await publicClient.readContract({ address: CONTRACTS.exchange, abi: EXCHANGE_ABI, functionName: 'MAX_FILLS' })) as bigint
  const q = (await publicClient.readContract({
    address: CONTRACTS.exchange,
    abi: EXCHANGE_ABI,
    functionName: 'getQuote',
    args: [usdgIn, maxFills],
  })) as { creditOut: bigint; usdgSpent: bigint; feeAtoms: bigint; fills: bigint; reason: number }
  const price = q.creditOut > 0n ? Number(q.usdgSpent + q.feeAtoms) / Number(q.creditOut) : Infinity
  return { usdgIn, ...q, maxFills, price }
}

export interface Purchase {
  quote: Quote
  approveTx: string | null
  buyTx: string
  creditOut: number
  usdgSpent: number
  activationId: string
  activatedUsd: number
  beneficiary: string
  gasEth: number
}

export class RefuelError extends Error {}

/**
 * Buys CREDIT from the order book and activates it for `beneficiary` in one transaction. Refuses
 * a quote above `maxPrice` USDG per CREDIT, allows `slippage` on the CREDIT received, and approves
 * only what this purchase can spend.
 */
export async function buyAndActivate(opts: {
  usdgIn: bigint
  beneficiary: string
  maxPrice: number
  slippage: number
  onStep?: (step: string) => void
}): Promise<Purchase> {
  const account = treasuryAccount()
  if (!account) throw new RefuelError('no treasury wallet configured (AGENT_WALLET_PRIVATE_KEY)')
  const wallet = createWalletClient({ account, chain: ROBINHOOD, transport: transport() })

  /**
   * Signs locally, so the hash is known before broadcast, then sends through the fallback RPCs. If
   * an endpoint already has it ("already known"), the transaction is out there: wait for it.
   */
  const send = async (to: Hex, data: Hex): Promise<Hex> => {
    const prepared = await wallet.prepareTransactionRequest({ account, to, data, chain: ROBINHOOD })
    const serialized = await wallet.signTransaction(prepared)
    const hash = keccak256(serialized)
    try {
      await wallet.sendRawTransaction({ serializedTransaction: serialized })
    } catch (err) {
      if (!/already known|known transaction|nonce too low/i.test(String(err))) throw err
    }
    return hash
  }
  const treasury = (await readTreasury())!
  const need = Number(formatUnits(opts.usdgIn, 6))
  if (treasury.usdg < need) throw new RefuelError(`treasury holds ${treasury.usdg} USDG, needs ${need}`)
  if (treasury.eth <= 0) throw new RefuelError('treasury has no ETH for gas')

  const q = await quote(opts.usdgIn)
  if (q.creditOut === 0n) throw new RefuelError(`the order book has no CREDIT to sell (stop reason ${q.reason})`)
  if (q.price > opts.maxPrice) {
    throw new RefuelError(`CREDIT costs $${q.price.toFixed(3)} on the book, above the $${opts.maxPrice} limit`)
  }
  const minCreditOut = (q.creditOut * BigInt(Math.round((1 - opts.slippage) * 10_000))) / 10_000n
  const spendCap = q.usdgSpent + q.feeAtoms
  opts.onStep?.(`quote: ${formatUnits(opts.usdgIn, 6)} USDG → ${formatUnits(q.creditOut, 6)} CREDIT at $${q.price.toFixed(3)} (${q.fills} fills)`)

  let gasWei = 0n
  let approveTx: string | null = null
  const allowance = (await publicClient.readContract({
    address: CONTRACTS.usdg,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, CONTRACTS.exchange],
  })) as bigint
  if (allowance < spendCap) {
    const hash = await send(CONTRACTS.usdg, encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [CONTRACTS.exchange, spendCap] }))
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
    if (receipt.status !== 'success') throw new RefuelError(`USDG approval reverted: ${txUrl(hash)}`)
    gasWei += receipt.gasUsed * receipt.effectiveGasPrice
    approveTx = hash
    opts.onStep?.(`approved ${formatUnits(spendCap, 6)} USDG for the Exchange: ${txUrl(hash)}`)
  }

  const beneficiary = pad(opts.beneficiary as Hex, { size: 32 })
  const call = { abi: EXCHANGE_ABI, functionName: 'buyAndActivate', args: [opts.usdgIn, minCreditOut, beneficiary, q.maxFills] } as const
  // Simulate first: a purchase that would revert costs nothing and says why.
  await publicClient.simulateContract({ account, address: CONTRACTS.exchange, ...call })
  const hash = await send(CONTRACTS.exchange, encodeFunctionData(call))
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (receipt.status !== 'success') throw new RefuelError(`buyAndActivate reverted: ${txUrl(hash)}`)
  gasWei += receipt.gasUsed * receipt.effectiveGasPrice

  // The CREDIT contract's Activated event is the on-chain receipt for the new AI balance.
  let activationId = ''
  let activated = 0n
  for (const entry of receipt.logs) {
    if (entry.address.toLowerCase() !== CONTRACTS.credit) continue
    try {
      const ev = decodeEventLog({ abi: CREDIT_ABI, data: entry.data, topics: entry.topics })
      if (ev.eventName === 'Activated') {
        const args = ev.args as unknown as { activationId: bigint; amount: bigint }
        activationId = args.activationId.toString()
        activated += args.amount
      }
    } catch {
      // not an event we read
    }
  }
  if (!activated) throw new RefuelError(`the transaction succeeded but emitted no Activated event: ${txUrl(hash)}`)
  const after = (await readTreasury())!
  return {
    quote: q,
    approveTx,
    buyTx: hash,
    creditOut: Number(formatUnits(activated, 6)),
    usdgSpent: Math.round((treasury.usdg - after.usdg) * 1e6) / 1e6,
    activationId,
    activatedUsd: Number(formatUnits(activated, 6)),
    beneficiary: opts.beneficiary,
    gasEth: Number(formatEther(gasWei)),
  }
}
