import { createHash } from 'crypto'
import type { ApprovalState } from '../contracts/approval.js'
import type { IntentObject } from '../contracts/intent.js'
import type { ResolvedPolicyProfile } from '../contracts/policyResolution.js'
import type { SignerProfile } from '../contracts/signerProfile.js'
import type {
  SignatureConstraints,
  SignatureRequest,
  TransactionEnvelope,
} from '../contracts/signing.js'
import type { SimulationRecord } from '../contracts/simulation.js'

export type BuildPaymentBatchSignatureRequestInput = {
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
  if (!value) return undefined
  return createHash('sha256').update(value).digest('hex')
}

function buildTransactionEnvelope(
  intent: IntentObject,
  sourceAddress: string,
): TransactionEnvelope {
  if (intent.action.type !== 'treasury.payment_batch') {
    throw new Error(
      `Payment batch signing requires treasury.payment_batch intent, received ${intent.action.type}.`,
    )
  }

  const payload = intent.action.payload
  const firstRecipient = payload.payments[0]?.destinationAddress
  if (!firstRecipient) {
    throw new Error('Payment batch signing requires at least one payment recipient.')
  }

  return {
    chainId: payload.chainId,
    network: payload.chainId,
    fromAddress: sourceAddress,
    toAddress: firstRecipient,
    nativeValue: '0',
    tokenMovements: payload.payments.map((payment) => ({
      assetSymbol: payload.assetSymbol,
      amount: payment.amount,
      fromAddress: sourceAddress,
      toAddress: payment.destinationAddress,
    })),
    transactionType: 'batch',
    messagePayload: {
      batchType: payload.batchType,
      treasuryId: payload.treasuryId,
      paymentCount: payload.payments.length,
    },
  }
}

function buildConstraints(
  input: BuildPaymentBatchSignatureRequestInput,
): SignatureConstraints {
  const executionExpiresAt =
    input.approvalState?.expiresAt ?? input.simulation.freshnessExpiresAt

  const recipientMaterial = input.intent.action.type === 'treasury.payment_batch'
    ? input.intent.action.payload.payments
      .map((payment) => `${payment.destinationAddress}:${payment.amount}`)
      .join('|')
    : undefined

  return {
    executionExpiresAt,
    maxGas: input.intent.constraints.gasBudgetLimit,
    maxSlippageBps: input.intent.constraints.slippageLimitBps,
    allowedRecipientHash: hashValue(recipientMaterial),
    allowedCalldataHash: undefined,
    requiredQuorum:
      input.resolvedPolicy.approvals.requiredApprovals > 0
        ? input.resolvedPolicy.approvals.requiredApprovals
        : undefined,
    requiredSimulationHash: input.simulation.resultHash,
  }
}

export function buildPaymentBatchSignatureRequest(
  input: BuildPaymentBatchSignatureRequestInput,
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
    approvalRefs: input.approvalState ? [input.approvalState.approvalStateId] : [],
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
