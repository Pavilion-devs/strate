import type {
  ISO8601String,
  PolicyProfileRef,
  RuntimeEnvironment,
} from './common.js'
import type { ApprovalClass } from './approval.js'

export type IntentStatus =
  | 'draft'
  | 'validated'
  | 'policy_checked'
  | 'approval_pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'executed'
  | 'failed'

export type IntentActionType =
  | 'wallet.create'
  | 'wallet.policy_update'
  | 'identity.start_kyc'
  | 'asset.transfer'
  | 'treasury.rebalance'
  | 'treasury.payment_batch'
  | 'governance.vote'
  | 'counterparty.whitelist'

export type AssetTransferIntentPayload = {
  sourceWalletId?: string
  destinationAddress: string
  chainId: string
  assetSymbol: string
  amount: string
  counterpartyId?: string
  note?: string
}

export type WalletCreateIntentPayload = {
  subjectType: 'individual' | 'team' | 'business'
  subjectId: string
  walletType: 'treasury' | 'ops' | 'user' | 'vendor'
  environment: RuntimeEnvironment
  signerProfileId?: string
  initialPolicyProfileId?: string
}

export type TreasuryRebalanceIntentPayload = {
  treasuryId: string
  sourceWalletId?: string
  destinationWalletId?: string
  chainId: string
  assetSymbol: string
  targetAmount: string
  objective:
    | 'buffer_restore'
    | 'yield_exit'
    | 'payment_readiness'
    | 'manual_rebalance'
}

export type TreasuryPaymentBatchIntentPayload = {
  treasuryId: string
  sourceWalletId?: string
  chainId: string
  assetSymbol: string
  payments: Array<{
    destinationAddress: string
    amount: string
    counterpartyId?: string
    note?: string
  }>
  batchType?: 'payroll' | 'vendor' | 'mixed'
}

export type IntentAction =
  | {
      type: 'asset.transfer'
      payload: AssetTransferIntentPayload
    }
  | {
      type: 'wallet.create'
      payload: WalletCreateIntentPayload
    }
  | {
      type: 'treasury.rebalance'
      payload: TreasuryRebalanceIntentPayload
    }
  | {
      type: 'treasury.payment_batch'
      payload: TreasuryPaymentBatchIntentPayload
    }
  | {
      type: Exclude<
        IntentActionType,
        'asset.transfer' | 'wallet.create' | 'treasury.rebalance' | 'treasury.payment_batch'
      >
      payload: Record<string, unknown>
    }

export type IntentScope = {
  organizationId?: string
  treasuryId?: string
  walletId?: string
  chainIds?: string[]
  assetSymbols?: string[]
  environment: RuntimeEnvironment
}

export type IntentConstraints = {
  maxValue?: string
  exactValue?: string
  allowedRecipients?: string[]
  allowedCounterpartyIds?: string[]
  slippageLimitBps?: number
  gasBudgetLimit?: string
  expiresAt?: ISO8601String
  replayProtectionRef?: string
  requiredSimulation?: boolean
  requiredSignerClass?: string
}

export type IntentExplanation = {
  originalRequestText?: string
  normalizedSummary: string
  effectStatement: string
  operatorNotes?: string
}

export type IntentPolicyRefs = {
  policyProfileId?: string
  policySnapshotHash?: string
  riskProfileId?: string
  trustProfileId?: string
}

export type IntentApprovalState = {
  approvalClass?: ApprovalClass
  requiredApproverRoles?: string[]
  approvalStateRef?: string
  approvedAt?: ISO8601String
  rejectedAt?: ISO8601String
}

export type IntentExecutionRefs = {
  runId?: string
  policyResolutionId?: string
  simulationRefs: string[]
  signatureRequestRefs: string[]
  broadcastRefs: string[]
  reportRef?: string
}

export type IntentObject = {
  intentId: string
  version: string
  createdAt: ISO8601String
  createdBy: {
    actorType: 'human' | 'agent' | 'system'
    actorId: string
    sessionId?: string
  }
  status: IntentStatus
  action: IntentAction
  scope: IntentScope
  constraints: IntentConstraints
  explanation: IntentExplanation
  policyRefs: IntentPolicyRefs
  approvals: IntentApprovalState
  executionRefs: IntentExecutionRefs
}

export type IntentSnapshot = {
  intent: IntentObject
  policyRef?: PolicyProfileRef
}
