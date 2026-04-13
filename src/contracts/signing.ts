import type {
  ArtifactType,
  IntentRef,
  ISO8601String,
  PolicyProfileRef,
  SignerClass,
} from './common.js'

export type TransactionEnvelope = {
  chainId: string
  network: string
  fromAddress: string
  toAddress: string
  calldata?: string
  messagePayload?: Record<string, unknown>
  nativeValue?: string
  tokenMovements: Array<{
    assetSymbol: string
    amount: string
    fromAddress?: string
    toAddress?: string
  }>
  nonce?: number
  gasLimit?: string
  maxFeePerGas?: string
  maxPriorityFeePerGas?: string
  transactionType: 'transfer' | 'contract_call' | 'batch' | 'meta_tx'
}

export type SignatureConstraints = {
  executionExpiresAt?: ISO8601String
  maxGas?: string
  maxSlippageBps?: number
  allowedRecipientHash?: string
  allowedCalldataHash?: string
  requiredQuorum?: number
  requiredSimulationHash?: string
}

export type SignatureRequest = {
  signatureRequestId: string
  createdAt: ISO8601String
  intentRef: IntentRef
  policyRef: PolicyProfileRef
  approvalRefs: string[]
  simulationRefs: string[]
  signer: {
    signerClass: Exclude<SignerClass, 'hardware_service'> | 'hardware_service'
    signerProfileId: string
  }
  transactionEnvelope: TransactionEnvelope
  constraints: SignatureConstraints
  explanation: {
    summary: string
    effectStatement: string
  }
}

export type SignatureResultStatus =
  | 'signed'
  | 'rejected'
  | 'pending'
  | 'expired'
  | 'failed'

export type SignatureResult = {
  status: SignatureResultStatus
  signatureRequestId: string
  signerProfileId: string
  signedPayloadRef?: string
  rawSignatureRef?: string
  transactionHash?: string
  denialReason?: string
  errorMessage?: string
  createdArtifacts?: Array<{
    artifactType: ArtifactType
    path: string
  }>
}

export interface SignerGateway {
  requestSignature(input: SignatureRequest): Promise<SignatureResult>
  getSignatureStatus(signatureRequestId: string): Promise<SignatureResultStatus>
  getSignatureResult(signatureRequestId: string): Promise<SignatureResult>
  cancelSignatureRequest(signatureRequestId: string): Promise<void>
}
