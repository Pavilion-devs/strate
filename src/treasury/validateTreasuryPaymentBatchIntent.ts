import type { IntentObject } from '../contracts/intent.js'

export type TreasuryPaymentBatchValidationResult = {
  valid: boolean
  issues: string[]
}

function isPositiveDecimal(value: string): boolean {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0
}

export function validateTreasuryPaymentBatchIntent(
  intent: IntentObject,
): TreasuryPaymentBatchValidationResult {
  if (intent.action.type !== 'treasury.payment_batch') {
    return { valid: false, issues: ['intent.action_not_payment_batch'] }
  }

  const payload = intent.action.payload
  const issues: string[] = []

  if (!payload.treasuryId?.trim()) issues.push('intent.treasury_id_missing')
  if (!payload.chainId?.trim() || payload.chainId === 'unknown') {
    issues.push('intent.chain_missing')
  }
  if (!payload.assetSymbol?.trim()) issues.push('intent.asset_missing')
  if (!Array.isArray(payload.payments) || payload.payments.length === 0) {
    issues.push('intent.payments_missing')
  }

  payload.payments.forEach((payment, index) => {
    if (!payment.destinationAddress?.trim()) {
      issues.push(`intent.payment_${index}_destination_missing`)
    }
    if (!isPositiveDecimal(payment.amount)) {
      issues.push(`intent.payment_${index}_amount_invalid`)
    }
  })

  return { valid: issues.length === 0, issues }
}
