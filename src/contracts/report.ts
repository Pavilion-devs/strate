import type { IntentActionType } from './intent.js'
import type { ISO8601String, IntentRef } from './common.js'
import type { ReconciliationStatus } from './reconciliation.js'

export type TransferCloseoutReport = {
  reportId: string
  runId: string
  sessionId: string
  actionType: IntentActionType
  createdAt: ISO8601String
  finalStatus: 'completed' | 'failed'
  summary: string
  intentRef?: IntentRef
  approvalStateRef?: string
  simulationRef?: string
  signatureRequestRef?: string
  signatureResultRef?: string
  broadcastRef?: string
  reconciliationId?: string
  reconciliationStatus?: ReconciliationStatus
  transactionHash?: string
  notes: string[]
}

export type RunCloseoutReport = {
  reportId: string
  runId: string
  sessionId: string
  actionType: IntentActionType
  createdAt: ISO8601String
  finalStatus: 'completed' | 'failed'
  summary: string
  intentRef?: IntentRef
  notes: string[]
  walletIds?: string[]
}
