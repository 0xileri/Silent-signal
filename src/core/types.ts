// The shapes everything else passes around. Money is always USD as Orbio reports it: the account
// balance is dollars of credit, and a call costs its tokens at the gateway's own per-token prices.

export type SourceType = 'rss' | 'reddit' | 'demo'

export interface Source {
  id: string
  name: string
  type: SourceType
  url: string
}

export interface SourceItem {
  id: string
  sourceId: string
  sourceName: string
  sourceType: SourceType
  url: string
  title: string
  text: string
  links: string[]
  publishedAt: string | null
  fetchedAt: string
  embedding: number[]
  demo: boolean
}

export type Action = 'IGNORE' | 'WATCH' | 'INVESTIGATE'

/** Every factor is normalized to 0..1 before weighting. */
export interface Factors {
  velocity: number
  diversity: number
  size: number
  severity: number
  novelty: number
}

export interface ClusterMetrics {
  mentions: number
  uniqueSources: number
  sources: string[]
  last15: number
  prev15: number
  meanSimilarity: number
  severityTerms: string[]
  missionTerms: string[]
  onMission: boolean
  firstSeen: string
  lastSeen: string
  similarTo: { clusterId: string; similarity: number } | null
}

export interface Check {
  label: string
  ok: boolean
  detail: string
}

export interface Decision {
  at: string
  score: number
  factors: Factors
  metrics: ClusterMetrics
  action: Action
  reason: string
  checks: Check[]
  estimateUsd: number | null
  budgetUsd: number
  investigationId: string | null
}

export type ClusterState = 'new' | 'ignored' | 'watching' | 'investigating' | 'resolved' | 'archived'

export interface SignalCluster {
  id: string
  representativeClaim: string
  itemIds: string[]
  centroid: number[]
  createdAt: string
  updatedAt: string
  state: ClusterState
  decisions: Decision[]
  investigationId: string | null
  demo: boolean
}

export type WorkerId = 'source-tracer' | 'cross-checker' | 'verifier'

export interface WorkerRun {
  id: WorkerId
  role: string
  model: string
  status: 'waiting' | 'running' | 'done' | 'failed' | 'skipped'
  estimateUsd: number
  costUsd: number
  startedAt: string | null
  finishedAt: string | null
  output: unknown
  error: string | null
}

export interface EvidenceDoc {
  ref: string
  name: string
  url: string
  kind: 'official' | 'linked'
  ok: boolean
  excerpt: string
  error: string | null
}

export type Status = 'supported' | 'partially_supported' | 'unsupported' | 'unclear'

export interface EvidenceLine {
  ref: string
  url: string
  source: string
  finding: string
}

export interface Artifact {
  claim: string
  status: Status
  confidence: number
  origin: { ref: string; url: string; source: string; firstSeen: string | null }
  finding: string[]
  evidenceFor: EvidenceLine[]
  evidenceAgainst: EvidenceLine[]
  unknowns: string[]
  recommendedAction: 'monitor' | 'alert' | 'escalate'
  rationale: string
}

export type InvestigationStatus = 'funded' | 'running' | 'verifying' | 'complete' | 'rejected' | 'failed'

export interface Investigation {
  id: string
  clusterId: string
  claim: string
  createdAt: string
  finishedAt: string | null
  status: InvestigationStatus
  maxBudgetUsd: number
  estimateUsd: number
  spentUsd: number
  balanceBefore: number | null
  balanceAfter: number | null
  keyPrefix: string | null
  contract: { task: string; deadlineSec: number; successConditions: string[] }
  trigger: { score: number; mentions: number; uniqueSources: number; last15: number; prev15: number }
  workers: WorkerRun[]
  evidence: EvidenceDoc[]
  artifact: Artifact | null
  acceptance: { accepted: boolean; checks: Check[] } | null
  alert: { channel: 'telegram' | 'dashboard'; sent: boolean; detail: string } | null
  error: string | null
  demo: boolean
}

export interface SpendEvent {
  id: string
  at: string
  investigationId: string
  workerId: WorkerId
  model: string
  purpose: string
  promptTokens: number
  completionTokens: number
  costUsd: number
  costSource: 'gateway' | 'price-list'
  keyPrefix: string
  balanceBefore: number | null
  balanceAfter: number | null
}
