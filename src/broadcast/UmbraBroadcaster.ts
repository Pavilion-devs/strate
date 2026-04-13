/**
 * UmbraBroadcaster
 *
 * Broadcaster implementation that routes transfers through the Umbra Privacy layer.
 *
 * ## Privacy path
 *
 * Uses the "direct deposit" path (ATA → ETA):
 *   - Tokens move from the sender's public Associated Token Account (ATA) into
 *     the recipient's Encrypted Token Account (ETA) via an Arcium MPC computation.
 *   - The amount is encrypted on-chain. The wallet-to-ETA link remains visible,
 *     but the transferred amount is hidden from public observation.
 *   - This is the lowest-friction Umbra path: no zkProver, no UTXO scanner,
 *     no Merkle-proof fetching required.
 *
 * ## Anonymous path (UTXO mixer — future extension)
 *
 * The anonymous path via `getPublicBalanceToReceiverClaimableUtxoCreatorFunction`
 * additionally hides the sender/receiver link, but requires:
 *   - A `zkProver` instance (Groth16 prover with circuit-specific proving keys)
 *   - A `relayer` for the claim step
 * That integration is left for the next iteration once proving keys are available.
 *
 * ## Amount handling
 *
 * The `transactionEnvelope.tokenMovements[0].amount` is a human-readable string
 * (e.g., "100" for 100 USDC). This broadcaster multiplies by 10^decimals using
 * a per-symbol decimals map; USDC defaults to 6 decimal places.
 */

import {
  getPublicBalanceToEncryptedBalanceDirectDepositorFunction,
} from '@umbra-privacy/sdk'
import type { IUmbraClient } from '@umbra-privacy/sdk'
import type {
  BroadcastInput,
  BroadcastRecord,
  BroadcastRefreshInput,
  Broadcaster,
} from '../contracts/broadcast.js'
import type { UmbraWalletProvider } from '../wallets/UmbraWalletProvider.js'
import { defaultIdGenerator, defaultNow } from '../runtime/types.js'

// ─── Token decimals by symbol ─────────────────────────────────────────────────

const TOKEN_DECIMALS: Record<string, number> = {
  USDC: 6,
  USDT: 6,
  wSOL: 9,
  SOL: 9,
  UMBRA: 9,
}

// ─── Dependencies ─────────────────────────────────────────────────────────────

export type UmbraBroadcasterDependencies = {
  /**
   * The wallet provider instance — used to obtain the Umbra client.
   * Exactly one of `walletProvider` or `client` must be supplied.
   */
  walletProvider?: UmbraWalletProvider
  /**
   * A pre-built Umbra client — alternative to walletProvider (testing).
   */
  client?: IUmbraClient
  /**
   * Mint address overrides per asset symbol. Defaults to the standard devnet/mainnet
   * addresses for USDC, USDT, and wSOL.
   */
  mintAddresses?: Record<string, string>
  network?: 'mainnet' | 'devnet' | 'localnet'
  now?: () => string
  createId?: (prefix: string) => string
}

// ─── Broadcaster ─────────────────────────────────────────────────────────────

export class UmbraBroadcaster implements Broadcaster {
  private readonly walletProvider: UmbraWalletProvider | undefined
  private readonly directClient: IUmbraClient | undefined
  private readonly mintAddresses: Record<string, string>
  private readonly network: 'mainnet' | 'devnet' | 'localnet'
  private readonly now: () => string
  private readonly createId: (prefix: string) => string

  constructor(deps: UmbraBroadcasterDependencies = {}) {
    if (!deps.walletProvider && !deps.client) {
      throw new Error('UmbraBroadcaster: supply either walletProvider or client')
    }
    this.walletProvider = deps.walletProvider
    this.directClient = deps.client
    this.network = deps.network ?? 'devnet'
    this.mintAddresses = deps.mintAddresses ?? defaultMintAddresses(this.network)
    this.now = deps.now ?? defaultNow
    this.createId = deps.createId ?? defaultIdGenerator
  }

  // ── Broadcaster interface ─────────────────────────────────────────────────

  async broadcastSignedTransfer(input: BroadcastInput): Promise<BroadcastRecord> {
    const client = await this.resolveClient()
    const network = `solana-${this.network}`

    const { transactionEnvelope, signatureRequestId } = input.signatureRequest
    const { toAddress, tokenMovements } = transactionEnvelope

    // Extract amount and asset from the first token movement
    const movement = tokenMovements.find((m) => m.toAddress === toAddress) ?? tokenMovements[0]
    if (!movement) {
      return this.failedRecord(input.runId, signatureRequestId, network, 'No token movements in transaction envelope')
    }

    const { assetSymbol, amount } = movement
    const mint = this.mintAddresses[assetSymbol]
    if (!mint) {
      return this.failedRecord(
        input.runId,
        signatureRequestId,
        network,
        `UmbraBroadcaster: no mint address registered for asset ${assetSymbol}. ` +
        `Register it via mintAddresses in the constructor.`,
      )
    }

    // Convert human-readable amount to raw token units (bigint)
    const decimals = TOKEN_DECIMALS[assetSymbol] ?? 6
    const rawAmount = toRawAmount(amount, decimals)

    try {
      // Build and invoke the Umbra direct deposit function.
      // This moves tokens from sender's ATA → recipient's Encrypted Token Account (ETA)
      // via an Arcium MPC computation. Amount is hidden on-chain.
      const deposit = getPublicBalanceToEncryptedBalanceDirectDepositorFunction({ client })

      // The deposit function signature:
      //   deposit(recipientAddress, mintAddress, amount, options?) → Promise<TransactionSignature>
      const txSignature = await deposit(
        toAddress as Parameters<typeof deposit>[0],
        mint as Parameters<typeof deposit>[1],
        rawAmount as Parameters<typeof deposit>[2],
      )

      return {
        broadcastId: this.createId('umbra_broadcast'),
        runId: input.runId,
        submittedAt: this.now(),
        status: 'confirmed',
        transactionHash: String(txSignature),
        network,
        signatureRequestId,
        summary:
          `Umbra confidential deposit: ${amount} ${assetSymbol} → ETA of ${toAddress}. ` +
          `Amount encrypted on-chain. Tx: ${String(txSignature)}`,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return this.failedRecord(input.runId, signatureRequestId, network, message)
    }
  }

  async refreshBroadcast(input: BroadcastRefreshInput): Promise<BroadcastRecord> {
    // For Umbra deposits, the Arcium MPC computation finalises asynchronously.
    // The submitted tx signature is confirmed once the queue instruction lands on-chain;
    // the MPC callback settles the encrypted balance update separately.
    // We return the existing record as confirmed — full finality can be tracked
    // via the Arcium computation monitor (future extension).
    if (!input.record.transactionHash) {
      return {
        ...input.record,
        status: 'failed',
        summary: 'No transaction hash to verify.',
      }
    }

    return {
      ...input.record,
      status: 'confirmed',
      summary:
        `Umbra deposit tx ${input.record.transactionHash} submitted. ` +
        `Arcium MPC computation is finalising the encrypted balance update.`,
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async resolveClient(): Promise<IUmbraClient> {
    if (this.directClient) return this.directClient
    if (this.walletProvider) return this.walletProvider.getClient()
    throw new Error('UmbraBroadcaster: no client or walletProvider available')
  }

  private failedRecord(
    runId: string,
    signatureRequestId: string,
    network: string,
    summary: string,
  ): BroadcastRecord {
    return {
      broadcastId: this.createId('umbra_broadcast'),
      runId,
      submittedAt: this.now(),
      status: 'failed',
      network,
      signatureRequestId,
      summary,
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Converts a human-readable amount string ("100.5") to raw token units (bigint).
 * Uses integer arithmetic to avoid floating-point rounding.
 */
function toRawAmount(amount: string, decimals: number): bigint {
  const [intPart = '0', fracPart = ''] = amount.split('.')
  const paddedFrac = fracPart.padEnd(decimals, '0').slice(0, decimals)
  return BigInt(intPart + paddedFrac)
}

function defaultMintAddresses(network: 'mainnet' | 'devnet' | 'localnet'): Record<string, string> {
  if (network === 'mainnet') {
    return {
      USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      wSOL: 'So11111111111111111111111111111111111111112',
    }
  }
  // devnet / localnet
  return {
    USDC: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    USDT: 'EJwZgeZrdC8TXTQbQBoL6bfuAnFUUy1PVCMB4DYPzVaS',
    wSOL: 'So11111111111111111111111111111111111111112',
  }
}
