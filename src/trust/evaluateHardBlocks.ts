import type { TrustSignalResult } from '../contracts/trust.js'
import type { TrustHardBlockDecision } from './types.js'

export function evaluateHardBlocks(
  signalResults: TrustSignalResult[],
): TrustHardBlockDecision {
  const blockingSignals = signalResults.filter(
    (signal) => signal.status === 'hard_block',
  )

  return {
    blocked: blockingSignals.length > 0,
    reasonCodes: [...new Set(blockingSignals.flatMap((signal) => signal.reasonCodes))],
    evidenceRefs: [
      ...new Set(blockingSignals.flatMap((signal) => signal.evidenceRefs)),
    ],
  }
}
