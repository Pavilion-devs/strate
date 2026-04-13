import type {
  ISO8601String,
  RuntimeEnvironment,
  TrustAssessmentStatus,
  TrustTier,
} from './common.js'

export type TrustSignalFamily =
  | 'identity_compliance'
  | 'provenance'
  | 'relationship_history'
  | 'operational_performance'
  | 'chain_screening'
  | 'route_protocol'
  | 'signer_control'
  | 'org_context'

export type TrustAssessmentInput = {
  objectType: 'wallet' | 'counterparty' | 'route' | 'subject'
  objectId: string
  evaluationContext: {
    organizationId?: string
    treasuryId?: string
    walletId?: string
    actionType?: string
    chain?: string
    asset?: string
    environment: RuntimeEnvironment
  }
  freshnessPolicy?: {
    maxAgeSeconds?: number
    requireFreshScreening?: boolean
  }
}

export type TrustSignalResult = {
  signalId: string
  family: TrustSignalFamily
  status: 'positive' | 'negative' | 'neutral' | 'missing' | 'hard_block'
  weight?: number
  reasonCodes: string[]
  evidenceRefs: string[]
  observedAt?: ISO8601String
}

export type TrustAssessment = {
  assessmentId: string
  objectType: 'wallet' | 'counterparty' | 'route' | 'subject'
  objectId: string
  computedAt: ISO8601String
  inputFingerprint: string
  freshness: {
    stale: boolean
    maxAgeSeconds?: number
  }
  trustTier: TrustTier
  trustScore: number
  status: TrustAssessmentStatus
  hardBlocks: string[]
  signalResults: TrustSignalResult[]
  reasonCodes: string[]
  evidenceRefs: string[]
  explanation: string
}

export type TrustExplanation = {
  assessmentId: string
  summary: string
  reasonCodes: string[]
  evidenceRefs: string[]
}

export interface TrustEngine {
  assess(input: TrustAssessmentInput): Promise<TrustAssessment>
  refresh(assessmentId: string): Promise<TrustAssessment>
  explain(assessmentId: string): Promise<TrustExplanation>
}
