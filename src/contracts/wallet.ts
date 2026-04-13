import type {
  ISO8601String,
  RuntimeEnvironment,
  SignerClass,
} from './common.js'

export type WalletLifecycleState =
  | 'draft'
  | 'provisioning'
  | 'created_unlinked'
  | 'linked_pending_policy'
  | 'pending_compliance'
  | 'active_receive_only'
  | 'active_limited'
  | 'active_full'
  | 'restricted'
  | 'suspended'
  | 'rotating'
  | 'closed'
  | 'failed_incomplete'

export type WalletComplianceStatus =
  | 'not_started'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'restricted'

export type WalletPolicyAttachmentStatus =
  | 'unassigned'
  | 'pending'
  | 'attached'
  | 'stale'

export type WalletSignerHealthStatus =
  | 'unknown'
  | 'healthy'
  | 'degraded'
  | 'unavailable'

export type WalletTrustStatus =
  | 'unassessed'
  | 'sufficient'
  | 'limited'
  | 'manual_review'
  | 'blocked'

export type WalletRecordType = 'treasury' | 'ops' | 'user' | 'vendor'

export type WalletRecord = {
  walletId: string
  createdAt: ISO8601String
  updatedAt: ISO8601String
  state: WalletLifecycleState
  organizationId?: string
  treasuryId?: string
  subjectId?: string
  walletType?: WalletRecordType
  address?: string
  supportedChains?: string[]
  signerProfileId?: string
  providerId?: string
  providerWalletId?: string
  providerWalletName?: string
  providerVaultPath?: string
  complianceWorkflowId?: string
  complianceProviderId?: string
  complianceProviderCaseId?: string
  complianceStatus: WalletComplianceStatus
  policyAttachmentStatus: WalletPolicyAttachmentStatus
  signerHealthStatus: WalletSignerHealthStatus
  trustStatus: WalletTrustStatus
}

export type WalletProviderResolutionInput = {
  walletId: string
  chainId: string
  environment: RuntimeEnvironment
  actionType: 'asset.transfer'
  requiredSignerClass?: SignerClass
  allowedSignerClasses?: SignerClass[]
}

export type ResolvedTransferSourceWallet = {
  providerId: string
  wallet: WalletRecord
  address: string
  signerProfileId: string
  signerClass: SignerClass
  supportedChains: string[]
}

export type WalletProvisionInput = {
  walletId: string
  walletType: WalletRecordType
  subjectId: string
  subjectType: 'individual' | 'team' | 'business'
  organizationId?: string
  treasuryId?: string
  signerProfileId?: string
  environment: RuntimeEnvironment
  supportedChains: string[]
}

export type ProvisionedWallet = {
  walletRecord: WalletRecord
  address: string
  providerId: string
  /** Present only if the provider generated a new keypair — MUST be stored securely */
  secretKeyBase64?: string
}

export interface WalletProvider {
  resolveTransferSource(
    input: WalletProviderResolutionInput,
  ): Promise<ResolvedTransferSourceWallet>
  provisionWallet(input: WalletProvisionInput): Promise<ProvisionedWallet>
}
