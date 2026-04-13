import type {
  IntentObject,
  TreasuryPaymentBatchIntentPayload,
} from '../contracts/intent.js'
import type { RuntimeEnvironment } from '../contracts/common.js'

export type BuildTreasuryPaymentBatchIntentInput = {
  intentId: string
  createdAt: string
  actor: { actorType: 'human' | 'agent' | 'system'; actorId: string; sessionId?: string }
  payload: TreasuryPaymentBatchIntentPayload
  scope: { organizationId?: string; treasuryId?: string; environment: RuntimeEnvironment }
  originalRequestText?: string
}

function computeBatchTotal(payments: TreasuryPaymentBatchIntentPayload['payments']): string {
  const total = payments.reduce((sum, payment) => {
    const amount = Number(payment.amount)
    return Number.isFinite(amount) ? sum + amount : sum
  }, 0)
  return String(total)
}

export function buildTreasuryPaymentBatchIntent(
  input: BuildTreasuryPaymentBatchIntentInput,
): IntentObject {
  const totalAmount = computeBatchTotal(input.payload.payments)
  const paymentCount = input.payload.payments.length
  const batchLabel = input.payload.batchType ?? 'mixed'

  return {
    intentId: input.intentId,
    version: 'v1',
    createdAt: input.createdAt,
    createdBy: input.actor,
    status: 'draft',
    action: {
      type: 'treasury.payment_batch',
      payload: input.payload,
    },
    scope: {
      organizationId: input.scope.organizationId,
      treasuryId: input.scope.treasuryId ?? input.payload.treasuryId,
      walletId: input.payload.sourceWalletId,
      chainIds: [input.payload.chainId],
      assetSymbols: [input.payload.assetSymbol],
      environment: input.scope.environment,
    },
    constraints: {
      requiredSimulation: true,
    },
    explanation: {
      originalRequestText: input.originalRequestText,
      normalizedSummary: `Execute ${batchLabel} payment batch: ${paymentCount} payments, total ${totalAmount} ${input.payload.assetSymbol} on ${input.payload.chainId}.`,
      effectStatement: `Move ${totalAmount} ${input.payload.assetSymbol} across ${paymentCount} recipients from treasury ${input.payload.treasuryId}.`,
    },
    policyRefs: {},
    approvals: {},
    executionRefs: {
      simulationRefs: [],
      signatureRequestRefs: [],
      broadcastRefs: [],
    },
  }
}
