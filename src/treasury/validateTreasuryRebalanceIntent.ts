import type { IntentObject } from '../contracts/intent.js'

export type TreasuryRebalanceValidationResult = {
  valid: boolean
  issues: string[]
}

function isPositiveDecimal(value: string): boolean {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0
}

export function validateTreasuryRebalanceIntent(
  intent: IntentObject,
): TreasuryRebalanceValidationResult {
  if (intent.action.type !== 'treasury.rebalance') {
    return { valid: false, issues: ['intent.action_not_rebalance'] }
  }

  const payload = intent.action.payload
  const issues: string[] = []

  if (!payload.treasuryId?.trim()) issues.push('intent.treasury_id_missing')
  if (!payload.chainId?.trim() || payload.chainId === 'unknown') issues.push('intent.chain_missing')
  if (!payload.assetSymbol?.trim()) issues.push('intent.asset_missing')
  if (!isPositiveDecimal(payload.targetAmount)) issues.push('intent.target_amount_invalid')
  if (!payload.objective) issues.push('intent.objective_missing')

  return { valid: issues.length === 0, issues }
}
