// Local sentence embeddings: a small open model (all-MiniLM-L6-v2, ~23 MB) running in this
// process through transformers.js. Deciding that seven posts say the same thing costs nothing.
import { existsSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { env, pipeline } from '@huggingface/transformers'
import { DATA_DIR } from '../core/store.js'

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'
const MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']

// The model lives with the data (a volume when deployed), and loads only from there: the agent
// downloads the files itself, so a failed download says why instead of failing inside the library.
const MODELS_DIR = join(DATA_DIR, 'models')
env.localModelPath = MODELS_DIR
env.allowRemoteModels = false
env.useFSCache = false

async function ensureModel(): Promise<void> {
  for (const file of MODEL_FILES) {
    const path = join(MODELS_DIR, EMBEDDING_MODEL, file)
    if (existsSync(path)) continue
    const url = `https://huggingface.co/${EMBEDDING_MODEL}/resolve/main/${file}`
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    if (!res.ok) throw new Error(`downloading ${url}: HTTP ${res.status}`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(`${path}.tmp`, new Uint8Array(await res.arrayBuffer()))
    await rename(`${path}.tmp`, path)
  }
}

const loadExtractor = async () => {
  await ensureModel()
  return pipeline('feature-extraction', EMBEDDING_MODEL, { dtype: 'q8' })
}
let extractor: ReturnType<typeof loadExtractor> | undefined

/** Unit-length vectors, one per text. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (!texts.length) return []
  extractor ??= loadExtractor()
  // A failed load is retried on the next scan rather than cached forever.
  const run = await extractor.catch((err) => {
    extractor = undefined
    throw err
  })
  const vectors: number[][] = []
  for (let i = 0; i < texts.length; i += 32) {
    const output = await run(texts.slice(i, i + 32), { pooling: 'mean', normalize: true })
    vectors.push(...(output.tolist() as number[][]).map((v) => v.map((x) => Math.round(x * 1e5) / 1e5)))
  }
  return vectors
}

/** Vectors are unit length, so the dot product is the cosine similarity. */
export function cosine(a: number[], b: number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!
  return sum
}

export function centroid(vectors: number[][]): number[] {
  const sum = new Array<number>(vectors[0]?.length ?? 0).fill(0)
  for (const v of vectors) for (let i = 0; i < v.length; i++) sum[i]! += v[i]!
  const norm = Math.hypot(...sum) || 1
  return sum.map((x) => Math.round((x / norm) * 1e5) / 1e5)
}

/** What gets embedded: the headline and the opening, where a post states its claim. */
export function claimText(item: { title: string; text: string }): string {
  const opening = item.text.split(/\s+/).slice(0, 60).join(' ')
  if (!item.title || opening.toLowerCase().startsWith(item.title.toLowerCase().slice(0, 40))) return opening
  return /[.!?:]$/.test(item.title) ? `${item.title} ${opening}` : `${item.title}. ${opening}`
}
