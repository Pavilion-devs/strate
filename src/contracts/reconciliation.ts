import type { ISO8601String } from './common.js'
import type { BroadcastRecord } from './broadcast.js'
import type { IntentObject } from './intent.js'
import type { SignatureResult } from './signing.js'
import type { SimulationRecord } from './simulation.js'

export type ReconciliationCheck = {
  checkId: string
  status: 'passed' | 'failed'
  reason?: string
}

export type ReconciliationStatus = 'matched' | 'mismatch' | 'failed'

export type ReconciliationInput = {
  runId: string
  intent: IntentObject
  simulation: SimulationRecord
  signatureResult: SignatureResult
  broadcast: BroadcastRecord
}

export type ReconciliationReport = {
  reconciliationId: string
  runId: string
  completedAt: ISO8601String
  status: ReconciliationStatus
  observedTransactionHash?: string
  summary: string
  checks: ReconciliationCheck[]
}

export interface Reconciler {
  reconcileTransfer(input: ReconciliationInput): Promise<ReconciliationReport>
}
