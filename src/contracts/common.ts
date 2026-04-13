export type ISO8601String = string

export type RuntimeEnvironment = 'production' | 'staging' | 'test'

export type ActorType = 'human' | 'agent' | 'system' | 'signer_backend'

export type RuntimeActor = {
  actorType: ActorType
  actorId: string
  role?: string
}

export type PolicyExecutionMode =
  | 'advisory'
  | 'copilot'
  | 'limited_autonomous'

export type PolicyResolutionStatus = 'allowed' | 'restricted' | 'denied'

export type SignerClass =
  | 'mpc'
  | 'multisig'
  | 'smart_account'
  | 'custodial'
  | 'hardware_service'

export type TrustTier = 'A' | 'B' | 'C' | 'D' | 'E'

export type TrustAssessmentStatus =
  | 'sufficient'
  | 'limited'
  | 'manual_review'
  | 'blocked'

export type LedgerRedactionLevel =
  | 'public'
  | 'restricted'
  | 'sensitive_ref_only'

export type IntentRef = {
  intentId: string
  version: string
}

export type PolicyProfileRef = {
  policyProfileId: string
  version: string
}

export type PolicyResolutionRef = {
  resolutionId: string
}

export type MonetaryAmount = {
  amount: string
  assetSymbol: string
}

export type WindowLimit = {
  amount: string
  period: 'per_tx' | 'per_day' | 'per_counterparty_period' | 'per_chain_period'
}

export type ArtifactType =
  | 'intent_snapshot'
  | 'policy_snapshot'
  | 'wallet_snapshot'
  | 'wallet_resolution'
  | 'trust_assessment'
  | 'simulation_record'
  | 'approval_record'
  | 'approval_review_package'
  | 'signature_request'
  | 'signature_result'
  | 'broadcast_record'
  | 'reconciliation_report'
  | 'note'
  | 'audit_report'
