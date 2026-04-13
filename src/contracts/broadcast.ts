import type { ISO8601String } from './common.js'
import type { SignatureRequest, SignatureResult } from './signing.js'

export type BroadcastStatus = 'submitted' | 'confirmed' | 'failed'

export type BroadcastInput = {
  runId: string
  sessionId: string
  signatureRequest: SignatureRequest
  signatureResult: SignatureResult
}

export type BroadcastRefreshInput = {
  runId: string
  sessionId: string
  record: BroadcastRecord
}

export type BroadcastRecord = {
  broadcastId: string
  runId: string
  submittedAt: ISO8601String
  status: BroadcastStatus
  transactionHash?: string
  network: string
  signatureRequestId: string
  summary: string
}

export interface Broadcaster {
  broadcastSignedTransfer(input: BroadcastInput): Promise<BroadcastRecord>
  refreshBroadcast(input: BroadcastRefreshInput): Promise<BroadcastRecord>
}
