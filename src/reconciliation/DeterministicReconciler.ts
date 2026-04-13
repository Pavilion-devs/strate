import type {
  ReconciliationInput,
  ReconciliationReport,
  Reconciler,
} from '../contracts/reconciliation.js'
import { defaultIdGenerator, defaultNow } from '../runtime/types.js'

type ReconcilerDependencies = {
  now?: () => string
  createId?: (prefix: string) => string
}

export class DeterministicReconciler implements Reconciler {
  private readonly now: () => string
  private readonly createId: (prefix: string) => string

  constructor(dependencies: ReconcilerDependencies = {}) {
    this.now = dependencies.now ?? defaultNow
    this.createId = dependencies.createId ?? defaultIdGenerator
  }

  async reconcileTransfer(
    input: ReconciliationInput,
  ): Promise<ReconciliationReport> {
    const action = input.intent.action
    const transferAssetAmountMatches =
      action.type === 'asset.transfer' &&
      input.simulation.expectedAssetDeltas.some(
        (delta) =>
          delta.direction === 'credit' &&
          delta.amount === action.payload.amount &&
          delta.assetSymbol === action.payload.assetSymbol &&
          delta.address === action.payload.destinationAddress,
      )
    const batchAssetAmountsMatch =
      action.type === 'treasury.payment_batch' &&
      action.payload.payments.every((payment) =>
        input.simulation.expectedAssetDeltas.some(
          (delta) =>
            delta.direction === 'credit' &&
            delta.amount === payment.amount &&
            delta.assetSymbol === action.payload.assetSymbol &&
            delta.address === payment.destinationAddress,
        ),
      )
    const assetAmountMatches = transferAssetAmountMatches || batchAssetAmountsMatch
    const expectedCheckId =
      action.type === 'treasury.payment_batch'
        ? 'reconciliation.batch_amounts_match_simulation'
        : 'reconciliation.asset_amount_matches_simulation'
    const expectedCheckReason =
      action.type === 'treasury.payment_batch'
        ? 'Simulated payment batch deltas do not match the batch intent.'
        : 'Simulated asset deltas do not match the transfer intent.'
    const actionSummaryLabel =
      action.type === 'treasury.payment_batch'
        ? 'payment batch'
        : 'transfer'

    const checks = [
      {
        checkId: 'reconciliation.transaction_hash_present',
        status: input.broadcast.transactionHash ? 'passed' : 'failed',
        reason: input.broadcast.transactionHash
          ? undefined
          : 'No transaction hash present on broadcast record.',
      },
      {
        checkId: expectedCheckId,
        status: assetAmountMatches ? 'passed' : 'failed',
        reason: assetAmountMatches
          ? undefined
          : expectedCheckReason,
      },
    ] as const

    const hasFailure = checks.some((check) => check.status === 'failed')
    return {
      reconciliationId: this.createId('reconciliation'),
      runId: input.runId,
      completedAt: this.now(),
      status: hasFailure ? 'mismatch' : 'matched',
      observedTransactionHash:
        input.broadcast.transactionHash ?? input.signatureResult.transactionHash,
      summary: hasFailure
        ? 'Reconciliation detected a mismatch.'
        : `Reconciliation matched the expected ${actionSummaryLabel} effects.`,
      checks: [...checks],
    }
  }
}
