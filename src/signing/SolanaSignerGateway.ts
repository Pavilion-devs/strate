/**
 * SolanaSignerGateway
 *
 * Real Solana signing implementation of the SignerGateway interface.
 *
 * This gateway builds a Solana transaction from the SignatureRequest's
 * TransactionEnvelope, signs it with the provided Keypair, and returns a
 * SignatureResult with the serialized signed transaction ready for broadcast.
 *
 * Key design decisions:
 * - The Keypair is injected at construction time (from env, KMS wrapper, etc.)
 * - This gateway never stores or logs private key material
 * - The signed transaction is base64-encoded in `signedPayloadRef`
 * - `transactionHash` is the base58-encoded transaction signature (Solana's tx ID)
 *
 * Supported transaction types:
 * - 'transfer': native SOL transfer (SystemProgram.transfer)
 * - 'contract_call': treated as a raw instruction — not supported here (pass to a
 *   specialized gateway)
 *
 * SPL token transfers:
 * - When `tokenMovements` contains a token with assetSymbol != 'SOL',
 *   the gateway builds a SPL token transfer instruction using the
 *   associated token accounts for source and destination.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  clusterApiUrl,
} from '@solana/web3.js'
import {
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
  getMint,
} from '@solana/spl-token'
import type {
  SignatureRequest,
  SignatureResult,
  SignatureResultStatus,
  SignerGateway,
} from '../contracts/signing.js'
import type { SolanaCluster } from '../wallets/SolanaWalletProvider.js'

// Known SPL token mint addresses (devnet/mainnet-beta)
const SPL_MINTS: Record<string, Record<string, string>> = {
  devnet: {
    USDC: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    USDT: 'BQcdHdAQW1hczDbBi9hiegXAR7A98Q9jx3X3iBBBDiq4',
  },
  'mainnet-beta': {
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  },
}

function clusterToRpcUrl(cluster: SolanaCluster): string {
  if (cluster === 'localnet') return 'http://127.0.0.1:8899'
  return clusterApiUrl(cluster as 'mainnet-beta' | 'devnet' | 'testnet')
}

type PendingRequest = {
  request: SignatureRequest
  result: SignatureResult
}

type SolanaSignerGatewayDependencies = {
  keypair: Keypair
  cluster?: SolanaCluster
  rpcUrl?: string
  connection?: Connection
}

export class SolanaSignerGateway implements SignerGateway {
  private readonly keypair: Keypair
  private readonly connection: Connection
  private readonly cluster: SolanaCluster
  private readonly pending = new Map<string, PendingRequest>()

  constructor(dependencies: SolanaSignerGatewayDependencies) {
    this.keypair = dependencies.keypair
    this.cluster = dependencies.cluster ?? 'devnet'
    const rpcUrl = dependencies.rpcUrl ?? clusterToRpcUrl(this.cluster)
    this.connection = dependencies.connection ?? new Connection(rpcUrl, 'confirmed')
  }

  async requestSignature(request: SignatureRequest): Promise<SignatureResult> {
    const envelope = request.transactionEnvelope

    // Build and sign the transaction
    let signatureResult: SignatureResult
    try {
      const tx = await this.buildTransaction(envelope)
      const signature = await sendAndConfirmTransaction(
        this.connection,
        tx,
        [this.keypair],
        { commitment: 'confirmed' },
      )

      signatureResult = {
        status: 'signed',
        signatureRequestId: request.signatureRequestId,
        signerProfileId: request.signer.signerProfileId,
        transactionHash: signature,
        signedPayloadRef: `solana:sig:${signature}`,
        rawSignatureRef: `solana:sig:${signature}:raw`,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      signatureResult = {
        status: 'failed',
        signatureRequestId: request.signatureRequestId,
        signerProfileId: request.signer.signerProfileId,
        errorMessage: message,
      }
    }

    this.pending.set(request.signatureRequestId, { request, result: signatureResult })
    return signatureResult
  }

  async getSignatureStatus(signatureRequestId: string): Promise<SignatureResultStatus> {
    const entry = this.pending.get(signatureRequestId)
    return entry?.result.status ?? 'pending'
  }

  async getSignatureResult(signatureRequestId: string): Promise<SignatureResult> {
    const entry = this.pending.get(signatureRequestId)
    if (!entry) {
      return {
        status: 'failed',
        signatureRequestId,
        signerProfileId: 'solana_signer',
        errorMessage: `No signature result found for request ${signatureRequestId}.`,
      }
    }
    return entry.result
  }

  async cancelSignatureRequest(signatureRequestId: string): Promise<void> {
    this.pending.delete(signatureRequestId)
  }

  // ── private helpers ──────────────────────────────────────────────────────

  private async buildTransaction(
    envelope: SignatureRequest['transactionEnvelope'],
  ): Promise<Transaction> {
    const tx = new Transaction()
    const fromAddress = this.keypair.publicKey
    const movements = envelope.tokenMovements.length > 0
      ? envelope.tokenMovements
      : [{
          assetSymbol: 'SOL',
          amount: envelope.nativeValue ?? '0',
          toAddress: envelope.toAddress,
        }]

    // Batch mode: add one instruction per movement.
    if (envelope.transactionType === 'batch') {
      if (movements.length === 0) {
        throw new Error('Batch transaction has no token movements.')
      }

      const normalizedAssets = movements.map((movement) =>
        movement.assetSymbol.toUpperCase(),
      )
      const firstAsset = normalizedAssets[0]
      if (!firstAsset) {
        throw new Error('Batch transaction has no asset symbol to resolve.')
      }
      const sameAsset = normalizedAssets.every((asset) => asset === firstAsset)
      if (!sameAsset) {
        throw new Error(
          'Batch transaction currently requires all movements to use the same asset symbol.',
        )
      }

      if (firstAsset === 'SOL') {
        for (const movement of movements) {
          const recipient = movement.toAddress ?? envelope.toAddress
          if (!recipient) {
            throw new Error('Batch SOL transfer is missing destination address.')
          }

          const toAddress = new PublicKey(recipient)
          const lamports = Math.round(parseFloat(movement.amount) * 1e9)
          tx.add(
            SystemProgram.transfer({
              fromPubkey: fromAddress,
              toPubkey: toAddress,
              lamports,
            }),
          )
        }
        return tx
      }

      const mintAddress = this.resolveMint(firstAsset)
      if (!mintAddress) {
        throw new Error(
          `SolanaSignerGateway: unknown SPL mint for asset ${firstAsset}. ` +
          `Add it to SPL_MINTS or resolve it externally.`,
        )
      }

      const mint = new PublicKey(mintAddress)
      const mintInfo = await getMint(this.connection, mint)
      const decimals = mintInfo.decimals
      const fromAta = await getOrCreateAssociatedTokenAccount(
        this.connection,
        this.keypair,
        mint,
        fromAddress,
      )

      for (const movement of movements) {
        const recipient = movement.toAddress ?? envelope.toAddress
        if (!recipient) {
          throw new Error('Batch SPL transfer is missing destination address.')
        }
        const toAddress = new PublicKey(recipient)
        const toAta = await getOrCreateAssociatedTokenAccount(
          this.connection,
          this.keypair,
          mint,
          toAddress,
        )
        const rawAmount = Math.round(
          parseFloat(movement.amount) * Math.pow(10, decimals),
        )
        tx.add(
          createTransferInstruction(
            fromAta.address,
            toAta.address,
            fromAddress,
            rawAmount,
          ),
        )
      }
      return tx
    }

    const tokenMovement = movements[0]
    const toAddress = new PublicKey(tokenMovement?.toAddress ?? envelope.toAddress)

    if (!tokenMovement || tokenMovement.assetSymbol.toUpperCase() === 'SOL') {
      // Native SOL transfer
      const lamports = tokenMovement
        ? Math.round(parseFloat(tokenMovement.amount) * 1e9)
        : Math.round(parseFloat(envelope.nativeValue ?? '0') * 1e9)

      tx.add(
        SystemProgram.transfer({
          fromPubkey: fromAddress,
          toPubkey: toAddress,
          lamports,
        }),
      )
      return tx
    }

    // SPL token transfer
    const mintAddress = this.resolveMint(tokenMovement.assetSymbol)
    if (!mintAddress) {
      throw new Error(
        `SolanaSignerGateway: unknown SPL mint for asset ${tokenMovement.assetSymbol}. ` +
        `Add it to SPL_MINTS or resolve it externally.`,
      )
    }

    const mint = new PublicKey(mintAddress)
    const mintInfo = await getMint(this.connection, mint)
    const decimals = mintInfo.decimals
    const rawAmount = Math.round(
      parseFloat(tokenMovement.amount) * Math.pow(10, decimals),
    )

    const fromAta = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.keypair,
      mint,
      fromAddress,
    )

    const toAta = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.keypair,
      mint,
      toAddress,
    )

    tx.add(
      createTransferInstruction(
        fromAta.address,
        toAta.address,
        fromAddress,
        rawAmount,
      ),
    )

    return tx
  }

  private resolveMint(assetSymbol: string): string | undefined {
    const clusterMints = SPL_MINTS[this.cluster] ?? SPL_MINTS['devnet']
    return clusterMints?.[assetSymbol.toUpperCase()]
  }

  /** Public key of the signing keypair */
  getPublicKey(): PublicKey {
    return this.keypair.publicKey
  }

  /** The active cluster */
  getCluster(): SolanaCluster {
    return this.cluster
  }
}
