import { createHash } from 'crypto'
import type {
  BroadcastInput,
  BroadcastRefreshInput,
  BroadcastRecord,
  BroadcastStatus,
  Broadcaster,
} from '../contracts/broadcast.js'
import { defaultIdGenerator, defaultNow } from '../runtime/types.js'

type DeterministicBroadcasterMode =
  | 'confirmed'
  | 'submitted'
  | 'confirm_on_refresh'

type BroadcasterDependencies = {
  now?: () => string
  createId?: (prefix: string) => string
  mode?: DeterministicBroadcasterMode
}

function buildTransactionHash(input: BroadcastInput): string {
  return (
    input.signatureResult.transactionHash ??
    `0x${createHash('sha256')
      .update(input.signatureRequest.signatureRequestId)
      .digest('hex')
      .slice(0, 64)}`
  )
}

export class DeterministicBroadcaster implements Broadcaster {
  private readonly now: () => string
  private readonly createId: (prefix: string) => string
  private readonly mode: DeterministicBroadcasterMode

  constructor(dependencies: BroadcasterDependencies = {}) {
    this.now = dependencies.now ?? defaultNow
    this.createId = dependencies.createId ?? defaultIdGenerator
    this.mode = dependencies.mode ?? 'confirmed'
  }

  async broadcastSignedTransfer(
    input: BroadcastInput,
  ): Promise<BroadcastRecord> {
    const status: BroadcastStatus =
      this.mode === 'confirm_on_refresh' ? 'submitted' : this.mode
    const transactionHash = buildTransactionHash(input)

    return {
      broadcastId: this.createId('broadcast'),
      runId: input.runId,
      submittedAt: this.now(),
      status,
      transactionHash,
      network: input.signatureRequest.transactionEnvelope.network,
      signatureRequestId: input.signatureRequest.signatureRequestId,
      summary:
        status === 'confirmed'
          ? `Broadcast confirmed on ${input.signatureRequest.transactionEnvelope.network}.`
          : `Broadcast submitted on ${input.signatureRequest.transactionEnvelope.network}.`,
    }
  }

  async refreshBroadcast(
    input: BroadcastRefreshInput,
  ): Promise<BroadcastRecord> {
    const status: BroadcastStatus =
      this.mode === 'submitted'
        ? 'submitted'
        : this.mode === 'confirm_on_refresh'
          ? 'confirmed'
          : 'confirmed'

    return {
      ...input.record,
      status,
      summary:
        status === 'confirmed'
          ? `Broadcast confirmed on ${input.record.network}.`
          : `Broadcast submitted on ${input.record.network}.`,
    }
  }
}
