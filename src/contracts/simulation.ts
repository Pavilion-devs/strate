import type {
  ISO8601String,
  IntentRef,
  PolicyResolutionRef,
} from './common.js'
import type { IntentObject } from './intent.js'
import type { ResolvedPolicyProfile } from './policyResolution.js'

export type SimulationStatus = 'succeeded' | 'failed' | 'blocked'

export type SimulationInvariant = {
  invariantId: string
  status: 'passed' | 'failed'
  reason?: string
}

export type SimulatedAssetDelta = {
  assetSymbol: string
  amount: string
  direction: 'debit' | 'credit'
  address?: string
}

export type TransferSimulationInput = {
  runId: string
  sessionId: string
  intent: IntentObject
  resolvedPolicy: ResolvedPolicyProfile
  materialHash: string
}

export type PaymentBatchSimulationInput = {
  runId: string
  sessionId: string
  intent: IntentObject
  resolvedPolicy: ResolvedPolicyProfile
  materialHash: string
}

export type SimulationRecord = {
  simulationId: string
  runId: string
  simulatedAt: ISO8601String
  status: SimulationStatus
  intentRef: IntentRef
  policyResolutionRef?: PolicyResolutionRef
  summary: string
  resultHash: string
  freshnessExpiresAt?: ISO8601String
  expectedAssetDeltas: SimulatedAssetDelta[]
  invariants: SimulationInvariant[]
}

export interface SimulationEngine {
  simulateTransfer(input: TransferSimulationInput): Promise<SimulationRecord>
  simulatePaymentBatch(
    input: PaymentBatchSimulationInput,
  ): Promise<SimulationRecord>
}
