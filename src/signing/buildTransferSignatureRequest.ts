import { createHash } from 'crypto'
import type { ApprovalState } from '../contracts/approval.js'
import type { IntentObject } from '../contracts/intent.js'
import type { ResolvedPolicyProfile } from '../contracts/policyResolution.js'
import type { SignerProfile } from '../contracts/signerProfile.js'
import type {
  SignatureRequest,
  SignatureConstraints,
  TransactionEnvelope,
} from '../contracts/signing.js'
import type { SimulationRecord } from '../contracts/simulation.js'

export type BuildTransferSignatureRequestInput = {
  signatureRequestId: string
  createdAt: string
  intent: IntentObject
  resolvedPolicy: ResolvedPolicyProfile
  simulation: SimulationRecord
  approvalState?: ApprovalState
  sourceAddress: string
  signerProfile: SignerProfile
}

function hashValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }

  return createHash('sha256').update(value).digest('hex')
}

function buildTransactionEnvelope(
  intent: IntentObject,
  sourceAddress: string,
): TransactionEnvelope {
  if (intent.action.type !== 'asset.transfer') {
    throw new Error(
      `Transfer signing requires an asset.transfer intent, received ${intent.action.type}.`,
    )
  }

  const payload = intent.action.payload
  return {
    chainId: payload.chainId,
    network: payload.chainId,
    fromAddress: sourceAddress,
    toAddress: payload.destinationAddress,
    nativeValue: '0',
    tokenMovements: [
      {
        assetSymbol: payload.assetSymbol,
        amount: payload.amount,
        fromAddress: sourceAddress,
        toAddress: payload.destinationAddress,
      },
    ],
    transactionType: 'transfer',
  }
}

function buildConstraints(
  input: BuildTransferSignatureRequestInput,
): SignatureConstraints {
  const executionExpiresAt =
    input.approvalState?.expiresAt ?? input.simulation.freshnessExpiresAt

  return {
    executionExpiresAt,
    maxGas: input.intent.constraints.gasBudgetLimit,
    maxSlippageBps: input.intent.constraints.slippageLimitBps,
    allowedRecipientHash:
      input.intent.action.type === 'asset.transfer'
        ? hashValue(input.intent.action.payload.destinationAddress)
        : undefined,
    allowedCalldataHash: undefined,
    requiredQuorum:
      input.resolvedPolicy.approvals.requiredApprovals > 0
        ? input.resolvedPolicy.approvals.requiredApprovals
        : undefined,
    requiredSimulationHash: input.simulation.resultHash,
  }
}

export function buildTransferSignatureRequest(
  input: BuildTransferSignatureRequestInput,
): SignatureRequest {
  const signerClass =
    input.resolvedPolicy.signing.requiredSignerClass ??
    input.signerProfile.signerClass

  return {
    signatureRequestId: input.signatureRequestId,
    createdAt: input.createdAt,
    intentRef: {
      intentId: input.intent.intentId,
      version: input.intent.version,
    },
    policyRef: {
      policyProfileId:
        input.resolvedPolicy.sourceProfiles[0]?.policyProfileId ?? 'resolved_policy',
      version: input.resolvedPolicy.sourceProfiles[0]?.version ?? 'resolved',
    },
    approvalRefs: input.approvalState
      ? [input.approvalState.approvalStateId]
      : [],
    simulationRefs: [input.simulation.simulationId],
    signer: {
      signerClass,
      signerProfileId: input.signerProfile.signerProfileId,
    },
    transactionEnvelope: buildTransactionEnvelope(input.intent, input.sourceAddress),
    constraints: buildConstraints(input),
    explanation: {
      summary: input.intent.explanation.normalizedSummary,
      effectStatement: input.intent.explanation.effectStatement,
    },
  }
}
