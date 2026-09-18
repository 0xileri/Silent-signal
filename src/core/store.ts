// JSON files under DATA_DIR (gitignored `data/` locally, a mounted volume when deployed).
// Writes go to a temp file first and are then renamed, so a crash never leaves half a file.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const DATA_DIR = process.env.DATA_DIR ?? 'data'

export function readJson<T>(file: string, fallback: T): T {
  const path = join(DATA_DIR, file)
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(DATA_DIR, { recursive: true })
  const path = join(DATA_DIR, file)
  writeFileSync(`${path}.tmp`, JSON.stringify(value))
  renameSync(`${path}.tmp`, path)
}
