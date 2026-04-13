import { createHash } from 'crypto'
import type { IntentObject } from '../contracts/intent.js'

type PaymentBatchMaterialEnvelope = {
  intentId: string
  intentVersion: string
  actionType: string
  treasuryId: string
  sourceWalletId?: string
  chainId: string
  assetSymbol: string
  batchType?: string
  payments: Array<{
    destinationAddress: string
    amount: string
    counterpartyId?: string
  }>
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    )
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`
  }

  return JSON.stringify(value)
}

function buildPaymentBatchMaterialEnvelope(
  intent: IntentObject,
): PaymentBatchMaterialEnvelope {
  if (intent.action.type !== 'treasury.payment_batch') {
    throw new Error(
      `Payment batch material hash requires treasury.payment_batch intent, received ${intent.action.type}.`,
    )
  }

  return {
    intentId: intent.intentId,
    intentVersion: intent.version,
    actionType: intent.action.type,
    treasuryId: intent.action.payload.treasuryId,
    sourceWalletId: intent.action.payload.sourceWalletId,
    chainId: intent.action.payload.chainId,
    assetSymbol: intent.action.payload.assetSymbol,
    batchType: intent.action.payload.batchType,
    payments: intent.action.payload.payments.map((payment) => ({
      destinationAddress: payment.destinationAddress,
      amount: payment.amount,
      counterpartyId: payment.counterpartyId,
    })),
  }
}

export function createPaymentBatchMaterialHash(intent: IntentObject): string {
  const envelope = buildPaymentBatchMaterialEnvelope(intent)
  return createHash('sha256').update(stableStringify(envelope)).digest('hex')
}
