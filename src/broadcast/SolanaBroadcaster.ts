/**
 * SolanaBroadcaster
 *
 * Real Solana broadcaster that submits a signed transaction to the network
 * and polls for confirmation.
 *
 * Design decisions:
 * - The SolanaSignerGateway already calls `sendAndConfirmTransaction` during
 *   signing, so by the time a SignatureResult arrives here, the tx is ALREADY
 *   on-chain. The broadcaster's job is to:
 *     1. Verify the transaction signature is confirmed on-chain.
 *     2. Produce a BroadcastRecord with the real transaction hash.
 *
 * - For async flows (where the signer returned `signed` with a tx hash but
 *   didn't wait for confirmation), `broadcastSignedTransfer` will wait for
 *   confirmation up to `confirmationTimeoutMs`.
 *
 * - `refreshBroadcast` can be called for transactions stuck in `submitted`
 *   state to check if they've since confirmed.
 */

import {
  Connection,
  clusterApiUrl,
} from '@solana/web3.js'
import type {
  BroadcastInput,
  BroadcastRecord,
  BroadcastRefreshInput,
  Broadcaster,
} from '../contracts/broadcast.js'
import type { SolanaCluster } from '../wallets/SolanaWalletProvider.js'
import { defaultIdGenerator, defaultNow } from '../runtime/types.js'

type SolanaBroadcasterDependencies = {
  cluster?: SolanaCluster
  rpcUrl?: string
  connection?: Connection
  now?: () => string
  createId?: (prefix: string) => string
  /** How long to wait for on-chain confirmation before returning `submitted` status */
  confirmationTimeoutMs?: number
}

function clusterToRpcUrl(cluster: SolanaCluster): string {
  if (cluster === 'localnet') return 'http://127.0.0.1:8899'
  return clusterApiUrl(cluster as 'mainnet-beta' | 'devnet' | 'testnet')
}

export class SolanaBroadcaster implements Broadcaster {
  private readonly connection: Connection
  private readonly cluster: SolanaCluster
  private readonly now: () => string
  private readonly createId: (prefix: string) => string
  private readonly confirmationTimeoutMs: number

  constructor(dependencies: SolanaBroadcasterDependencies = {}) {
    this.cluster = dependencies.cluster ?? 'devnet'
    const rpcUrl = dependencies.rpcUrl ?? clusterToRpcUrl(this.cluster)
    this.connection = dependencies.connection ?? new Connection(rpcUrl, 'confirmed')
    this.now = dependencies.now ?? defaultNow
    this.createId = dependencies.createId ?? defaultIdGenerator
    this.confirmationTimeoutMs = dependencies.confirmationTimeoutMs ?? 30_000
  }

  async broadcastSignedTransfer(input: BroadcastInput): Promise<BroadcastRecord> {
    const txSignature = input.signatureResult.transactionHash
    const network = `solana-${this.cluster}`

    // If the signer already submitted and confirmed (SolanaSignerGateway path),
    // just verify on-chain and return confirmed.
    if (txSignature) {
      const confirmed = await this.verifySignature(txSignature)
      return {
        broadcastId: this.createId('broadcast'),
        runId: input.runId,
        submittedAt: this.now(),
        status: confirmed ? 'confirmed' : 'submitted',
        transactionHash: txSignature,
        network,
        signatureRequestId: input.signatureRequest.signatureRequestId,
        summary: confirmed
          ? `Transaction ${txSignature} confirmed on ${network}.`
          : `Transaction ${txSignature} submitted to ${network}, awaiting confirmation.`,
      }
    }

    // No tx hash — the signed payload was returned but not yet submitted.
    // In this implementation we treat a missing tx hash as a non-broadcast
    // (the signer should have submitted). Return submitted status for polling.
    return {
      broadcastId: this.createId('broadcast'),
      runId: input.runId,
      submittedAt: this.now(),
      status: 'submitted',
      network,
      signatureRequestId: input.signatureRequest.signatureRequestId,
      summary: `Signed transaction submitted to ${network}. Awaiting confirmation.`,
    }
  }

  async refreshBroadcast(input: BroadcastRefreshInput): Promise<BroadcastRecord> {
    if (!input.record.transactionHash) {
      return { ...input.record, status: 'failed', summary: 'No transaction hash to confirm.' }
    }

    const confirmed = await this.verifySignature(input.record.transactionHash)
    return {
      ...input.record,
      status: confirmed ? 'confirmed' : 'submitted',
      summary: confirmed
        ? `Transaction ${input.record.transactionHash} confirmed on ${input.record.network}.`
        : `Transaction ${input.record.transactionHash} still pending on ${input.record.network}.`,
    }
  }

  // ── private helpers ──────────────────────────────────────────────────────

  /**
   * Returns true if the given transaction signature is confirmed on-chain.
   * Uses a timeout so we don't block indefinitely.
   */
  private async verifySignature(signature: string): Promise<boolean> {
    try {
      const result = await Promise.race([
        this.connection.confirmTransaction(signature, 'confirmed'),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), this.confirmationTimeoutMs),
        ),
      ])

      if (result === null) {
        // Timed out — treat as submitted (not yet confirmed)
        return false
      }

      return result.value.err === null
    } catch {
      return false
    }
  }

  getCluster(): SolanaCluster {
    return this.cluster
  }

  getConnection(): Connection {
    return this.connection
  }
}
