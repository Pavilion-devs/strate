import type { ApprovalClass, ApprovalStatus } from './approval.js'
import type { IntentRef, ISO8601String } from './common.js'
import type { SimulatedAssetDelta, SimulationInvariant } from './simulation.js'
import type { TrustAssessmentStatus, TrustTier } from './common.js'

export type ApprovalMaterialView = {
  materialHash: string
  sourceLabel?: string
  destinationLabel?: string
  chain?: string
  asset?: string
  amount?: string
  signerClass?: string
  routeSummary?: string
  payloadHash?: string
}

export type ApprovalSimulationView = {
  simulationId?: string
  status?: 'succeeded' | 'failed' | 'blocked'
  simulatedAt?: ISO8601String
  freshnessExpiresAt?: ISO8601String
  expectedAssetDeltas?: SimulatedAssetDelta[]
  failedInvariants?: SimulationInvariant[]
}

export type ApprovalTrustView = {
  minimumCounterpartyTrustTier?: TrustTier
  minimumWalletTrustTier?: TrustTier
  counterpartyStatus?: TrustAssessmentStatus
  walletStatus?: TrustAssessmentStatus
  routeStatus?: TrustAssessmentStatus
  manualReviewRequired?: boolean
}

export type ApprovalReviewPackage = {
  requirementId: string
  approvalStateId: string
  status: ApprovalStatus
  approvalClass: ApprovalClass
  actionSummary: {
    actionType: string
    title: string
    humanSummary: string
    effectStatement: string
  }
  intentRef: IntentRef
  policyRef?: {
    resolutionId: string
    policyProfileId?: string
    version?: string
  }
  materialView: ApprovalMaterialView
  simulationView?: ApprovalSimulationView
  trustView?: ApprovalTrustView
  roleRequirements: {
    requiredApprovals: number
    requiredRoles?: string[]
    roleSeparationRequired?: boolean
  }
  timing: {
    createdAt: ISO8601String
    viewedAt?: ISO8601String
    expiresAt?: ISO8601String
  }
  reasonCodes: string[]
}

