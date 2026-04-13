import type { IntentObject } from '../contracts/intent.js'

export type WalletCreateIntentValidationResult = {
  valid: boolean
  issues: string[]
}

const ALLOWED_SUBJECT_TYPES = new Set(['individual', 'team', 'business'])
const ALLOWED_WALLET_TYPES = new Set(['treasury', 'ops', 'user', 'vendor'])

export function validateWalletCreateIntent(
  intent: IntentObject,
): WalletCreateIntentValidationResult {
  if (intent.action.type !== 'wallet.create') {
    return {
      valid: false,
      issues: ['intent.action_not_wallet_create'],
    }
  }

  const issues: string[] = []
  const payload = intent.action.payload

  if (!payload.subjectId.trim()) {
    issues.push('intent.subject_missing')
  }

  if (!ALLOWED_SUBJECT_TYPES.has(payload.subjectType)) {
    issues.push('intent.subject_type_invalid')
  }

  if (!ALLOWED_WALLET_TYPES.has(payload.walletType)) {
    issues.push('intent.wallet_type_invalid')
  }

  if (!payload.environment.trim()) {
    issues.push('intent.environment_missing')
  }

  return {
    valid: issues.length === 0,
    issues,
  }
}
