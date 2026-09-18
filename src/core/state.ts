// Everything the agent remembers, in one JSON file under DATA_DIR: items it has read (with their
// embeddings), clusters, investigations, the spend ledger and its own bookkeeping. Saves are
// batched, so a burst of updates during an investigation is one write.
import { readJson, writeJson } from './store.js'
import type { Investigation, SignalCluster, SourceItem, SpendEvent } from './types.js'

export interface BalanceReading {
  at: string
  balanceUsd: number
  spentUsd: number
  accruedUsd: number
  note: string
}

export interface AgentMemory {
  startedAt: string | null
  startBalanceUsd: number | null
  balances: BalanceReading[]
  paused: boolean
  /** The operator (or a spend anomaly) revoked the key: stay keyless, even across restarts, until a Claim. */
  keyRevokedHold: boolean
  scans: number
  lastScanAt: string | null
  itemsRead: number
  keyEvents: { at: string; event: 'claim' | 'rotate' | 'revoke' | 'retired'; prefix: string | null; detail: string }[]
}

interface State {
  items: SourceItem[]
  clusters: SignalCluster[]
  investigations: Investigation[]
  spend: SpendEvent[]
  agent: AgentMemory
}

const FILE = 'state.json'

const empty = (): State => ({
  items: [],
  clusters: [],
  investigations: [],
  spend: [],
  agent: {
    startedAt: null,
    startBalanceUsd: null,
    balances: [],
    paused: false,
    keyRevokedHold: false,
    scans: 0,
    lastScanAt: null,
    itemsRead: 0,
    keyEvents: [],
  },
})

const loaded = readJson<State>(FILE, empty())

export const state = {
  items: new Map(loaded.items.map((i) => [i.id, i])),
  clusters: loaded.clusters,
  investigations: loaded.investigations,
  spend: loaded.spend,
  agent: { ...empty().agent, ...loaded.agent },
}

let timer: NodeJS.Timeout | undefined

export function save(): void {
  clearTimeout(timer)
  timer = setTimeout(saveNow, 300)
}

export function saveNow(): void {
  clearTimeout(timer)
  writeJson(FILE, {
    items: [...state.items.values()],
    clusters: state.clusters,
    investigations: state.investigations.slice(-50),
    spend: state.spend.slice(-500),
    agent: { ...state.agent, balances: state.agent.balances.slice(-500), keyEvents: state.agent.keyEvents.slice(-100) },
  } satisfies State)
}

export const missionSpentUsd = () => Math.round(state.spend.reduce((sum, s) => sum + s.costUsd, 0) * 1e6) / 1e6
export const lastBalance = () => state.agent.balances.at(-1) ?? null
