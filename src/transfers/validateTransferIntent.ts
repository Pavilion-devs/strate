import type { IntentObject } from '../contracts/intent.js'

export type TransferIntentValidationResult = {
  valid: boolean
  issues: string[]
}

function isPositiveDecimal(value: string): boolean {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0
}

export function validateTransferIntent(
  intent: IntentObject,
): TransferIntentValidationResult {
  if (intent.action.type !== 'asset.transfer') {
    return {
      valid: false,
      issues: ['intent.action_not_transfer'],
    }
  }

  const issues: string[] = []
  const payload = intent.action.payload

  if (!payload.destinationAddress.trim()) {
    issues.push('intent.destination_missing')
  }

  if (!payload.chainId.trim() || payload.chainId === 'unknown') {
    issues.push('intent.chain_missing')
  }

  if (!payload.assetSymbol.trim()) {
    issues.push('intent.asset_missing')
  }

  if (!isPositiveDecimal(payload.amount)) {
    issues.push('intent.amount_invalid')
  }

  if (!payload.sourceWalletId?.trim()) {
    issues.push('intent.source_wallet_missing')
  }

  if (
    intent.constraints.allowedRecipients &&
    !intent.constraints.allowedRecipients.includes(payload.destinationAddress)
  ) {
    issues.push('intent.destination_not_allowed')
  }

  return {
    valid: issues.length === 0,
    issues,
  }
}
