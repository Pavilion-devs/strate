import type {
  IntentObject,
  IntentScope,
  WalletCreateIntentPayload,
} from '../contracts/intent.js'
import type { RuntimeEnvironment } from '../contracts/common.js'

export type BuildWalletCreateIntentInput = {
  intentId: string
  createdAt: string
  actor: {
    actorType: 'human' | 'agent' | 'system'
    actorId: string
    sessionId?: string
  }
  environment: RuntimeEnvironment
  payload: WalletCreateIntentPayload
  organizationId?: string
  treasuryId?: string
  originalRequestText?: string
  normalizedSummary?: string
  effectStatement?: string
  operatorNotes?: string
}

function buildScope(input: BuildWalletCreateIntentInput): IntentScope {
  return {
    organizationId: input.organizationId,
    treasuryId: input.treasuryId,
    environment: input.environment,
  }
}

export function buildWalletCreateIntent(
  input: BuildWalletCreateIntentInput,
): IntentObject {
  return {
    intentId: input.intentId,
    version: 'v1',
    createdAt: input.createdAt,
    createdBy: input.actor,
    status: 'draft',
    action: {
      type: 'wallet.create',
      payload: input.payload,
    },
    scope: buildScope(input),
    constraints: {},
    explanation: {
      originalRequestText: input.originalRequestText,
      normalizedSummary:
        input.normalizedSummary ??
        `Create a ${input.payload.walletType} wallet for ${input.payload.subjectId}.`,
      effectStatement:
        input.effectStatement ??
        `Provision a governed ${input.payload.walletType} wallet for ${input.payload.subjectType} subject ${input.payload.subjectId}.`,
      operatorNotes: input.operatorNotes,
    },
    policyRefs: {
      policyProfileId: input.payload.initialPolicyProfileId,
    },
    approvals: {},
    executionRefs: {
      simulationRefs: [],
      signatureRequestRefs: [],
      broadcastRefs: [],
    },
  }
}
