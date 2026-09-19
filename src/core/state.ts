// Everything the agent remembers, in one JSON file under DATA_DIR: items it has read (with their
// embeddings), clusters, investigations, the spend ledger and its own bookkeeping. Saves are
// batched, so a burst of updates during an investigation is one write.
import { readJson, writeJson } from './store.js'
import { POLICY } from '../config.js'
import type { Investigation, Refuel, SignalCluster, SourceItem, SpendEvent, WorkerRecord } from './types.js'

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
  /** The worker market's track records, by worker id. */
  reputation: Record<string, WorkerRecord>
  /** Self-refuels from the treasury, newest last. */
  refuels: Refuel[]
  /** When the public (non-operator) demo ran, for its daily cap. */
  publicDemos: string[]
  /** Cost of spend events trimmed from the ledger file, so the budget never forgets old spend. */
  archivedSpentUsd: number
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
    reputation: {},
    refuels: [],
    publicDemos: [],
    archivedSpentUsd: 0,
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

const KEEP_SPEND = 500

export function saveNow(): void {
  clearTimeout(timer)
  if (state.spend.length > KEEP_SPEND) {
    const trimmed = state.spend.splice(0, state.spend.length - KEEP_SPEND)
    state.agent.archivedSpentUsd = Math.round(((state.agent.archivedSpentUsd ?? 0) + trimmed.reduce((sum, s) => sum + s.costUsd, 0)) * 1e6) / 1e6
  }
  writeJson(FILE, {
    items: [...state.items.values()],
    clusters: state.clusters,
    investigations: state.investigations.slice(-50),
    spend: state.spend,
    agent: { ...state.agent, balances: state.agent.balances.slice(-500), keyEvents: state.agent.keyEvents.slice(-100) },
  } satisfies State)
}

/** The operator's budget plus every refuel confirmed in the Orbio balance: the agent may spend what it bought. */
export const refueledUsd = () =>
  Math.round((state.agent.refuels ?? []).filter((r) => r.status === 'confirmed').reduce((sum, r) => sum + (r.activatedUsd ?? 0), 0) * 1e6) / 1e6
export const missionBudgetUsd = () => Math.round((POLICY.budgetUsd + refueledUsd()) * 1e6) / 1e6

export const missionSpentUsd = () =>
  Math.round(((state.agent.archivedSpentUsd ?? 0) + state.spend.reduce((sum, s) => sum + s.costUsd, 0)) * 1e6) / 1e6
export const lastBalance = () => state.agent.balances.at(-1) ?? null
