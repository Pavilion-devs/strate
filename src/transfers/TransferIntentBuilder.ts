import type {
  AssetTransferIntentPayload,
  IntentObject,
  IntentScope,
} from '../contracts/intent.js'
import type { RuntimeEnvironment } from '../contracts/common.js'

export type BuildTransferIntentInput = {
  intentId: string
  createdAt: string
  actor: {
    actorType: 'human' | 'agent' | 'system'
    actorId: string
    sessionId?: string
  }
  environment: RuntimeEnvironment
  payload: AssetTransferIntentPayload
  organizationId?: string
  treasuryId?: string
  walletId?: string
  assetSymbols?: string[]
  chainIds?: string[]
  originalRequestText?: string
  normalizedSummary?: string
  effectStatement?: string
  operatorNotes?: string
  constraints?: {
    maxValue?: string
    exactValue?: string
    allowedRecipients?: string[]
    allowedCounterpartyIds?: string[]
    expiresAt?: string
    requiredSimulation?: boolean
    requiredSignerClass?: string
    gasBudgetLimit?: string
    slippageLimitBps?: number
  }
}

function buildScope(input: BuildTransferIntentInput): IntentScope {
  return {
    organizationId: input.organizationId,
    treasuryId: input.treasuryId,
    walletId: input.walletId ?? input.payload.sourceWalletId,
    chainIds: input.chainIds ?? [input.payload.chainId],
    assetSymbols: input.assetSymbols ?? [input.payload.assetSymbol],
    environment: input.environment,
  }
}

export function buildTransferIntent(
  input: BuildTransferIntentInput,
): IntentObject {
  return {
    intentId: input.intentId,
    version: 'v1',
    createdAt: input.createdAt,
    createdBy: input.actor,
    status: 'draft',
    action: {
      type: 'asset.transfer',
      payload: input.payload,
    },
    scope: buildScope(input),
    constraints: {
      maxValue: input.constraints?.maxValue,
      exactValue: input.constraints?.exactValue ?? input.payload.amount,
      allowedRecipients:
        input.constraints?.allowedRecipients ??
        [input.payload.destinationAddress],
      allowedCounterpartyIds: input.constraints?.allowedCounterpartyIds,
      slippageLimitBps: input.constraints?.slippageLimitBps,
      gasBudgetLimit: input.constraints?.gasBudgetLimit,
      expiresAt: input.constraints?.expiresAt,
      replayProtectionRef: undefined,
      requiredSimulation: input.constraints?.requiredSimulation ?? true,
      requiredSignerClass: input.constraints?.requiredSignerClass,
    },
    explanation: {
      originalRequestText: input.originalRequestText,
      normalizedSummary:
        input.normalizedSummary ??
        `Transfer ${input.payload.amount} ${input.payload.assetSymbol} on ${input.payload.chainId}.`,
      effectStatement:
        input.effectStatement ??
        `Move ${input.payload.amount} ${input.payload.assetSymbol} to ${input.payload.destinationAddress}.`,
      operatorNotes: input.operatorNotes,
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
