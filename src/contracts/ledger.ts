import type {
  ArtifactType,
  IntentRef,
  ISO8601String,
  LedgerRedactionLevel,
  PolicyProfileRef,
  RuntimeActor,
} from './common.js'
import type { RuntimePhase } from './runtime.js'

export type LedgerRefs = {
  intentRef?: IntentRef
  policyRef?: PolicyProfileRef
  approvalRefs?: string[]
  simulationRefs?: string[]
  signatureRequestRef?: string
  broadcastRef?: string
  walletIds?: string[]
  treasuryIds?: string[]
}

export type ArtifactRef = {
  artifactId: string
  artifactType: ArtifactType
  path: string
  hash?: string
}

export type LedgerEvent = {
  eventId: string
  eventType: string
  at: ISO8601String
  sessionId?: string
  runId: string
  phase: RuntimePhase
  actor: RuntimeActor
  refs: LedgerRefs
  summary: string
  payload: Record<string, unknown>
  artifactRefs?: ArtifactRef[]
  redactionLevel?: LedgerRedactionLevel
}

export interface ExecutionLedger {
  append(event: LedgerEvent): Promise<void>
  listForRun(runId: string): Promise<LedgerEvent[]>
}
