import type {
  TrustAssessment,
  TrustAssessmentInput,
  TrustExplanation,
  TrustSignalResult,
} from '../contracts/trust.js'

export type TrustAssessmentRecord = {
  assessment: TrustAssessment
  input: TrustAssessmentInput
}

export type TrustHardBlockDecision = {
  blocked: boolean
  reasonCodes: string[]
  evidenceRefs: string[]
}

export type TrustScoringResult = {
  score: number
  tier: TrustAssessment['trustTier']
  status: TrustAssessment['status']
}

export type TrustExplanationInput = {
  assessment: TrustAssessment
}

export type TrustCollectorOutput = {
  signalResults: TrustSignalResult[]
}

export type TrustStoredExplanation = TrustExplanation
