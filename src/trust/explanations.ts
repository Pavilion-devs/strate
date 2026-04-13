import type { TrustAssessment } from '../contracts/trust.js'
import type { TrustExplanationInput, TrustStoredExplanation } from './types.js'

export function buildTrustExplanation({
  assessment,
}: TrustExplanationInput): TrustStoredExplanation {
  const topReasons = assessment.reasonCodes.slice(0, 3).join(', ') || 'no_reasons'
  const summary =
    assessment.status === 'blocked'
      ? `Trust assessment for ${assessment.objectType} ${assessment.objectId} is blocked due to ${topReasons}.`
      : `Trust assessment for ${assessment.objectType} ${assessment.objectId} is ${assessment.status} at tier ${assessment.trustTier} due to ${topReasons}.`

  return {
    assessmentId: assessment.assessmentId,
    summary,
    reasonCodes: assessment.reasonCodes,
    evidenceRefs: assessment.evidenceRefs,
  }
}
