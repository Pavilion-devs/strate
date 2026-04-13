import type {
  ISO8601String,
  PolicyExecutionMode,
  PolicyResolutionStatus,
  RuntimeEnvironment,
  SignerClass,
  TrustAssessmentStatus,
  TrustTier,
} from './common.js'
import type { ApprovalClass } from './approval.js'
import type { IntentActionType } from './intent.js'
import type { PolicyProfile } from './policy.js'
import type {
  WalletComplianceStatus,
  WalletLifecycleState,
  WalletRecordType,
  WalletSignerHealthStatus,
  WalletTrustStatus,
} from './wallet.js'

export type ResolvedScope = {
  environment: RuntimeEnvironment
  allowedChains: string[]
  deniedChains: string[]
  allowedWalletIds: string[]
  allowedTreasuryIds: string[]
  allowedAssets: string[]
  deniedAssets: string[]
}

export type ResolvedPermissions = {
  actionType: IntentActionType
  maxPerTransaction?: string
  allowedSignerClasses: SignerClass[]
  simulationRequired: boolean
  manualReviewOnly: boolean
  allowlistedRecipientOnly: boolean
  approvedCounterpartyIds: string[]
  blockedCounterpartyIds: string[]
  approvedBridgeIds: string[]
  approvedRouterIds: string[]
  blockedProtocolIds: string[]
}

export type ResolvedApprovalRules = {
  approvalClass: ApprovalClass
  requiredApprovals: number
  requiredRoles: string[]
  roleSeparationRequired: boolean
  reason: string
  expiresAt?: ISO8601String
}

export type ResolvedSigningRules = {
  allowedSignerClasses: SignerClass[]
  requiredSignerClass?: SignerClass
  requireSimulation: boolean
  simulationFreshnessSeconds?: number
  broadcastAllowed: boolean
}

export type ResolvedComplianceRules = {
  kycRequired: boolean
  kybRequired: boolean
  sanctionsScreeningRequired: boolean
  sourceOfFundsRequired: boolean
  restrictedJurisdictions: string[]
  status: 'satisfied' | 'missing' | 'blocked'
}

export type ResolvedTrustRules = {
  minimumCounterpartyTrustTier?: TrustTier
  minimumWalletTrustTier?: TrustTier
  counterpartyStatus?: TrustAssessmentStatus
  walletStatus?: TrustAssessmentStatus
  routeStatus?: TrustAssessmentStatus
  manualReviewRequired: boolean
}

export type ResolvedEmergencyState = {
  haltActive: boolean
  pausedOutboundTransfers: boolean
  pausedProductionSigning: boolean
  breakGlassRoles: string[]
}

export type ToolPermissionDecision = {
  status: 'allowed' | 'approval_required' | 'denied'
  reasonCodes: string[]
}

export type PolicySourceRef = {
  policyProfileId: string
  version: string
  precedence: number
  scopeType:
    | 'organization'
    | 'environment'
    | 'treasury'
    | 'wallet'
    | 'actor_role'
    | 'action'
    | 'emergency'
}

export type ResolvedPolicyProfile = {
  resolutionId: string
  resolvedAt: ISO8601String
  mode: PolicyExecutionMode
  status: PolicyResolutionStatus
  action: {
    actionType: IntentActionType
    intentId: string
    intentVersion: string
  }
  scope: ResolvedScope
  permissions: ResolvedPermissions
  approvals: ResolvedApprovalRules
  signing: ResolvedSigningRules
  compliance: ResolvedComplianceRules
  trust: ResolvedTrustRules
  emergency: ResolvedEmergencyState
  derivedToolPolicy: Record<string, ToolPermissionDecision>
  sourceProfiles: PolicySourceRef[]
  reasonCodes: string[]
  explanation: string
}

export type PolicyResolutionInput = {
  runId: string
  sessionId: string
  environment: RuntimeEnvironment
  actor: {
    actorId: string
    roleIds: string[]
  }
  intentRef: {
    intentId: string
    version: string
    actionType: IntentActionType
  }
  walletContext?: {
    walletId?: string
    walletType?: WalletRecordType
    signerClass?: SignerClass
    signerProfileId?: string
    address?: string
    providerId?: string
    state?: WalletLifecycleState
    complianceStatus?: WalletComplianceStatus
    signerHealthStatus?: WalletSignerHealthStatus
    trustStatus?: WalletTrustStatus
  }
  treasuryContext?: {
    treasuryId?: string
  }
  identityFacts?: Record<string, unknown>
  complianceFacts?: Record<string, unknown>
  trustFacts?: Record<string, unknown>
  emergencyState?: Record<string, unknown>
  policyCandidates: PolicyProfile[]
}

export interface PolicyResolver {
  resolve(input: PolicyResolutionInput): Promise<ResolvedPolicyProfile>
}
