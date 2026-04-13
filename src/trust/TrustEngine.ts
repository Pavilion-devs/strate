import { createHash } from 'crypto'
import type {
  TrustAssessment,
  TrustAssessmentInput,
  TrustEngine,
  TrustExplanation,
} from '../contracts/trust.js'
import type { WalletRegistry } from '../wallets/WalletRegistry.js'
import { defaultIdGenerator, defaultNow } from '../runtime/types.js'
import { collectTrustSignals } from './collectSignals.js'
import { evaluateHardBlocks } from './evaluateHardBlocks.js'
import { scoreAssessment } from './scoreAssessment.js'
import { buildTrustExplanation } from './explanations.js'
import type { TrustAssessmentRecord } from './types.js'

type DeterministicTrustEngineDependencies = {
  wallets?: WalletRegistry
  now?: () => string
  createId?: (prefix: string) => string
}

export class DeterministicTrustEngine implements TrustEngine {
  private readonly wallets?: WalletRegistry
  private readonly now: () => string
  private readonly createId: (prefix: string) => string
  private readonly assessments = new Map<string, TrustAssessmentRecord>()

  constructor(dependencies: DeterministicTrustEngineDependencies = {}) {
    this.wallets = dependencies.wallets
    this.now = dependencies.now ?? defaultNow
    this.createId = dependencies.createId ?? defaultIdGenerator
  }

  async assess(input: TrustAssessmentInput): Promise<TrustAssessment> {
    const computedAt = this.now()
    const normalizedInput = {
      ...input,
      freshnessPolicy: input.freshnessPolicy ?? {},
    }
    const signalResults = await collectTrustSignals(normalizedInput, {
      wallets: this.wallets,
    })
    const hardBlockDecision = evaluateHardBlocks(signalResults)
    const scoring = scoreAssessment({
      signalResults,
      blocked: hardBlockDecision.blocked,
    })
    const reasonCodes = [
      ...new Set([
        ...signalResults.flatMap((signal) => signal.reasonCodes),
        ...hardBlockDecision.reasonCodes,
      ]),
    ]
    const evidenceRefs = [
      ...new Set([
        ...signalResults.flatMap((signal) => signal.evidenceRefs),
        ...hardBlockDecision.evidenceRefs,
      ]),
    ]
    const assessment: TrustAssessment = {
      assessmentId: this.createId('trust_assessment'),
      objectType: normalizedInput.objectType,
      objectId: normalizedInput.objectId,
      computedAt,
      inputFingerprint: createHash('sha256')
        .update(JSON.stringify(normalizedInput))
        .digest('hex'),
      freshness: {
        stale: false,
        maxAgeSeconds: normalizedInput.freshnessPolicy?.maxAgeSeconds,
      },
      trustTier: scoring.tier,
      trustScore: scoring.score,
      status: scoring.status,
      hardBlocks: hardBlockDecision.reasonCodes,
      signalResults,
      reasonCodes,
      evidenceRefs,
      explanation: '',
    }
    assessment.explanation = buildTrustExplanation({ assessment }).summary

    this.assessments.set(assessment.assessmentId, {
      assessment,
      input: normalizedInput,
    })

    return assessment
  }

  async refresh(assessmentId: string): Promise<TrustAssessment> {
    const existing = this.assessments.get(assessmentId)
    if (!existing) {
      throw new Error(`Unknown trust assessment ${assessmentId}.`)
    }

    return this.assess(existing.input)
  }

  async explain(assessmentId: string): Promise<TrustExplanation> {
    const existing = this.assessments.get(assessmentId)
    if (!existing) {
      throw new Error(`Unknown trust assessment ${assessmentId}.`)
    }

    return buildTrustExplanation({ assessment: existing.assessment })
  }
}
