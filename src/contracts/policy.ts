import type {
  ISO8601String,
  PolicyExecutionMode,
  RuntimeEnvironment,
  SignerClass,
  TrustTier,
  WindowLimit,
} from './common.js'
import type { IntentActionType } from './intent.js'

export type PolicyScope = {
  environments: RuntimeEnvironment[]
  allowedChains: string[]
  deniedChains?: string[]
  allowedWalletIds?: string[]
  allowedTreasuryIds?: string[]
  allowedAssets?: string[]
  deniedAssets?: string[]
}

export type ActionPermission = {
  enabled: boolean
  maxPerTransaction?: string
  allowedSignerClasses?: SignerClass[]
  simulationRequired?: boolean
  approvalRequired?: boolean
  manualReviewOnly?: boolean
  allowActiveLimitedAutoApproval?: boolean
}

export type PolicyCounterpartyRules = {
  allowlistedRecipientOnly?: boolean
  approvedCounterpartyIds?: string[]
  firstTimeRecipientManualReviewOver?: string
  blockedCounterpartyIds?: string[]
}

export type PolicyProtocolRules = {
  approvedBridgeIds?: string[]
  approvedRouterIds?: string[]
  blockedProtocolIds?: string[]
  arbitraryContractInteractionsAllowed?: boolean
}

export type PolicySignerRules = {
  allowedSignerClasses: SignerClass[]
  minimumSignerThresholdByAction?: Partial<Record<IntentActionType, number>>
  strongerSignerRequiredOver?: string
}

export type PolicySimulationRules = {
  requireTransferSimulation?: boolean
  requireBridgeSimulation?: boolean
  requireSwapSimulation?: boolean
  simulationFreshnessSeconds?: number
  requireResultHashMatch?: boolean
}

export type PolicyPermissions = {
  actions: Partial<Record<IntentActionType, ActionPermission>>
  allowedAssets?: string[]
  deniedAssets?: string[]
  valueControls?: WindowLimit[]
  counterparty: PolicyCounterpartyRules
  protocols: PolicyProtocolRules
  signer: PolicySignerRules
  simulation: PolicySimulationRules
}

export type PolicyApprovalRule = {
  autoApproveUnder?: string
  singleApprovalUnder?: string
  dualApprovalOver?: string
  requiredRoles?: string[]
  roleSeparationRequired?: boolean
  approvalExpirySeconds?: number
}

export type PolicyApprovalRules = Partial<Record<IntentActionType, PolicyApprovalRule>>

export type PolicyIdentityRules = {
  requireKycForWalletActivation?: boolean
  requireKybForTreasuryActions?: boolean
  requireSanctionsScreeningBeforeTransfer?: boolean
  sourceOfFundsRequiredOver?: string
  restrictedJurisdictions?: string[]
}

export type PolicyTrustRules = {
  minimumCounterpartyTrustTier?: TrustTier
  minimumWalletTrustTier?: TrustTier
  blockedRouteIds?: string[]
  anomalyEscalationThreshold?: 'low' | 'medium' | 'high'
  firstTimeCounterpartyManualReviewOver?: string
}

export type PolicyEmergencyRules = {
  emergencyHaltEnabled: boolean
  pauseAllOutboundTransfers?: boolean
  pauseProductionSigning?: boolean
  breakGlassRoles?: string[]
  incidentModeRestrictions?: string[]
}

export type PolicyProfile = {
  policyProfileId: string
  version: string
  createdAt: ISO8601String
  updatedAt: ISO8601String
  owner: {
    organizationId?: string
    treasuryId?: string
    walletId?: string
  }
  mode: PolicyExecutionMode
  scope: PolicyScope
  permissions: PolicyPermissions
  approvals: PolicyApprovalRules
  identity: PolicyIdentityRules
  trust: PolicyTrustRules
  emergency: PolicyEmergencyRules
  derivedToolPolicy?: Record<string, unknown>
}
