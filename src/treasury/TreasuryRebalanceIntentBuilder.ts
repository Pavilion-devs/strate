import type { IntentObject, TreasuryRebalanceIntentPayload } from '../contracts/intent.js'
import type { RuntimeEnvironment } from '../contracts/common.js'

export type BuildTreasuryRebalanceIntentInput = {
  intentId: string
  createdAt: string
  actor: { actorType: 'human' | 'agent' | 'system'; actorId: string; sessionId?: string }
  payload: TreasuryRebalanceIntentPayload
  scope: { organizationId?: string; treasuryId?: string; environment: RuntimeEnvironment }
  originalRequestText?: string
}

export function buildTreasuryRebalanceIntent(input: BuildTreasuryRebalanceIntentInput): IntentObject {
  const objectiveLabel: Record<TreasuryRebalanceIntentPayload['objective'], string> = {
    buffer_restore: 'restore operating buffer',
    yield_exit: 'exit yield position',
    payment_readiness: 'prepare funds for upcoming payments',
    manual_rebalance: 'manual rebalance',
  }

  const label = objectiveLabel[input.payload.objective]
  const summary = `Rebalance ${input.payload.targetAmount} ${input.payload.assetSymbol} on ${input.payload.chainId} to ${label}.`

  return {
    intentId: input.intentId,
    version: 'v1',
    createdAt: input.createdAt,
    createdBy: input.actor,
    status: 'draft',
    action: {
      type: 'treasury.rebalance',
      payload: input.payload,
    },
    scope: {
      organizationId: input.scope.organizationId,
      treasuryId: input.scope.treasuryId ?? input.payload.treasuryId,
      chainIds: [input.payload.chainId],
      assetSymbols: [input.payload.assetSymbol],
      environment: input.scope.environment,
    },
    constraints: {
      requiredSimulation: true,
    },
    explanation: {
      originalRequestText: input.originalRequestText,
      normalizedSummary: summary,
      effectStatement: `Move ${input.payload.targetAmount} ${input.payload.assetSymbol} within treasury ${input.payload.treasuryId} to ${label}.`,
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
