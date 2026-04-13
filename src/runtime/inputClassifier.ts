import type { IntentActionType } from '../contracts/intent.js'
import type { KernelInput, KernelInputKind } from '../contracts/runtime.js'

const ACTION_HINTS: Array<{
  pattern: RegExp
  actionType: IntentActionType
}> = [
  { pattern: /\b(send|pay|transfer)\b/i, actionType: 'asset.transfer' },
  { pattern: /\bcreate\b.*\bwallet\b/i, actionType: 'wallet.create' },
  { pattern: /\bkyc\b/i, actionType: 'identity.start_kyc' },
  { pattern: /\brebalance\b/i, actionType: 'treasury.rebalance' },
  { pattern: /\bpayment batch\b/i, actionType: 'treasury.payment_batch' },
]

const STATUS_QUERY_PATTERN =
  /\b(status|what happened|show|list|pending|history|yesterday)\b/i

const OPERATOR_COMMAND_PATTERN =
  /\b(show pending approvals|approval package|show pending compliance|pending compliance|halt run|resume run|close session)\b/i

export function detectRequestedActionType(
  text?: string,
): IntentActionType | undefined {
  if (!text) {
    return undefined
  }

  for (const hint of ACTION_HINTS) {
    if (hint.pattern.test(text)) {
      return hint.actionType
    }
  }

  return undefined
}

export function classifyKernelInput(input: KernelInput): KernelInputKind {
  if (input.kind) {
    return input.kind
  }

  if (input.requestedActionType) {
    return 'action_request'
  }

  if (input.payload?.callbackEvent) {
    return 'callback_event'
  }

  if (input.runId && !input.text) {
    return 'resume_signal'
  }

  if (input.text && OPERATOR_COMMAND_PATTERN.test(input.text)) {
    return 'operator_command'
  }

  if (input.text && detectRequestedActionType(input.text)) {
    return 'action_request'
  }

  if (input.text && STATUS_QUERY_PATTERN.test(input.text)) {
    return 'status_query'
  }

  return 'conversational'
}
