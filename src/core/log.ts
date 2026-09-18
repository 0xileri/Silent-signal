// The agent's activity log: one line per thing it did, readable in the terminal, on the dashboard
// and in data/events.jsonl. Numbers in it are real readings, never placeholders.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './store.js'

export type Actor =
  | 'AGENT'
  | 'WATCHER'
  | 'SIGNAL'
  | 'COORDINATOR'
  | 'BUDGET'
  | 'BALANCE'
  | 'KEY'
  | 'WORKER'
  | 'MARKET'
  | 'FUEL'
  | 'VERIFIER'
  | 'SPEND'
  | 'ALERT'
  | 'DEMO'
  | 'ERROR'

export interface LogEntry {
  at: string
  actor: Actor
  msg: string
  data?: Record<string, unknown>
}

const FILE = join(DATA_DIR, 'events.jsonl')
const KEEP = 400

const recent: LogEntry[] = existsSync(FILE)
  ? readFileSync(FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-KEEP)
      .map((line) => JSON.parse(line) as LogEntry)
  : []

export function log(actor: Actor, msg: string, data?: Record<string, unknown>): void {
  const entry: LogEntry = { at: new Date().toISOString(), actor, msg, ...(data && { data }) }
  recent.push(entry)
  if (recent.length > KEEP) recent.splice(0, recent.length - KEEP)
  mkdirSync(DATA_DIR, { recursive: true })
  appendFileSync(FILE, JSON.stringify(entry) + '\n')
  console.log(`[${entry.at.slice(11, 19)}] ${actor.padEnd(11)} ${msg}`)
}

export function recentLog(limit = 150): LogEntry[] {
  return recent.slice(-limit)
}
