import type { TrustSignalResult } from '../contracts/trust.js'
import type { TrustScoringResult } from './types.js'

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score))
}

function mapTier(score: number): TrustScoringResult['tier'] {
  if (score >= 85) return 'A'
  if (score >= 72) return 'B'
  if (score >= 58) return 'C'
  if (score >= 40) return 'D'
  return 'E'
}

export function scoreAssessment(input: {
  signalResults: TrustSignalResult[]
  blocked: boolean
}): TrustScoringResult {
  let score = 50

  for (const signal of input.signalResults) {
    const weight = Math.abs(signal.weight ?? 0)
    if (signal.status === 'positive') score += weight
    if (signal.status === 'negative' || signal.status === 'missing') score -= weight
    if (signal.status === 'hard_block') score -= Math.max(weight, 20)
  }

  const normalizedScore = clampScore(score)
  const tier = mapTier(normalizedScore)

  if (input.blocked) {
    return {
      score: normalizedScore,
      tier: 'E',
      status: 'blocked',
    }
  }

  if (tier === 'A' || tier === 'B') {
    return {
      score: normalizedScore,
      tier,
      status: 'sufficient',
    }
  }

  if (tier === 'C') {
    return {
      score: normalizedScore,
      tier,
      status: 'limited',
    }
  }

  return {
    score: normalizedScore,
    tier,
    status: 'manual_review',
  }
}
