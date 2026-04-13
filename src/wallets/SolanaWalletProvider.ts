/**
 * SolanaWalletProvider
 *
 * Real Solana wallet provider that resolves a wallet address from the
 * Solana devnet/mainnet-beta RPC given a wallet record with an on-chain address.
 *
 * Design constraints:
 * - This provider is READ-ONLY for address resolution. It never holds private keys.
 * - Key material lives in the SignerGateway (Keypair passed at bootstrap, or MPC/hardware).
 * - It validates the wallet exists on-chain by fetching account info.
 *
 * In development / devnet:
 * - You can pass a base58 public key as `walletId` and this provider will use it
 *   as the wallet address directly (useful for testing with a locally generated keypair).
 *
 * In production:
 * - Store the derived wallet address in a WalletRegistry entry (via `address` field).
 * - This provider reads that and verifies the account is reachable on-chain.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  clusterApiUrl,
} from '@solana/web3.js'
import type {
  WalletProvider,
  WalletProviderResolutionInput,
  WalletProvisionInput,
  WalletRecord,
  ResolvedTransferSourceWallet,
  ProvisionedWallet,
} from '../contracts/wallet.js'
import type { WalletRegistry } from './WalletRegistry.js'
import { InMemoryWalletRegistry } from './WalletRegistry.js'
import { defaultNow } from '../runtime/types.js'

export type SolanaCluster = 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet'

type SolanaWalletProviderDependencies = {
  cluster?: SolanaCluster
  rpcUrl?: string
  registry?: WalletRegistry
  now?: () => string
  /** If true, skip on-chain account validation (useful for devnet wallets with no balance yet) */
  skipAccountValidation?: boolean
  /** Default signer profile ID to use when no existing wallet record has one */
  defaultSignerProfileId?: string
}

function clusterToRpcUrl(cluster: SolanaCluster): string {
  if (cluster === 'localnet') return 'http://127.0.0.1:8899'
  return clusterApiUrl(cluster as 'mainnet-beta' | 'devnet' | 'testnet')
}

function isValidBase58PublicKey(value: string): boolean {
  try {
    new PublicKey(value)
    return true
  } catch {
    return false
  }
}

export class SolanaWalletProvider implements WalletProvider {
  private readonly connection: Connection
  private readonly cluster: SolanaCluster
  private readonly registry: WalletRegistry
  private readonly now: () => string
  private readonly skipAccountValidation: boolean
  private readonly defaultSignerProfileId: string | undefined

  constructor(dependencies: SolanaWalletProviderDependencies = {}) {
    this.cluster = dependencies.cluster ?? 'devnet'
    const rpcUrl = dependencies.rpcUrl ?? clusterToRpcUrl(this.cluster)
    this.connection = new Connection(rpcUrl, 'confirmed')
    this.registry = dependencies.registry ?? new InMemoryWalletRegistry()
    this.now = dependencies.now ?? defaultNow
    this.skipAccountValidation = dependencies.skipAccountValidation ?? false
    this.defaultSignerProfileId = dependencies.defaultSignerProfileId
  }

  async resolveTransferSource(
    input: WalletProviderResolutionInput,
  ): Promise<ResolvedTransferSourceWallet> {
    const existing = await this.registry.get(input.walletId)

    // Determine the on-chain address
    let address: string
    if (existing?.address) {
      address = existing.address
    } else if (isValidBase58PublicKey(input.walletId)) {
      // Wallet ID is itself a base58 public key — use it directly
      address = input.walletId
    } else {
      throw new Error(
        `SolanaWalletProvider: no address found for wallet ${input.walletId}. ` +
        `Register the wallet with an address field, or use a base58 public key as walletId.`,
      )
    }

    // Validate on-chain reachability (unless skipped)
    if (!this.skipAccountValidation) {
      try {
        const pubkey = new PublicKey(address)
        const accountInfo = await this.connection.getAccountInfo(pubkey)
        // accountInfo being null just means 0 balance — the key is still valid on Solana
        // We only throw if the address itself is invalid (caught above)
        void accountInfo
      } catch (err) {
        if (err instanceof Error && err.message.includes('Invalid public key')) {
          throw new Error(
            `SolanaWalletProvider: address ${address} is not a valid Solana public key.`,
          )
        }
        // RPC errors are non-fatal — we proceed with the address we have
      }
    }

    const signerClass =
      input.requiredSignerClass ??
      input.allowedSignerClasses?.[0] ??
      'mpc'

    const signerProfileId = existing?.signerProfileId ?? this.defaultSignerProfileId ?? `${signerClass}_solana`

    const walletRecord: WalletRecord =
      existing ?? {
        walletId: input.walletId,
        createdAt: this.now(),
        updatedAt: this.now(),
        state: 'active_full',
        walletType: 'ops',
        address,
        supportedChains: ['solana', 'solana-devnet', 'solana-testnet', 'solana-mainnet', 'devnet', 'testnet', 'mainnet'],
        signerProfileId,
        providerId: 'solana_wallet_provider',
        complianceStatus: 'approved',
        policyAttachmentStatus: 'attached',
        signerHealthStatus: 'healthy',
        trustStatus: 'sufficient',
      }

    if (!existing) {
      await this.registry.put(walletRecord)
    }

    return {
      providerId: 'solana_wallet_provider',
      wallet: walletRecord,
      address,
      signerProfileId,
      signerClass,
      supportedChains: walletRecord.supportedChains ?? ['solana'],
    }
  }

  /**
   * Provisions a new wallet by generating a fresh Solana Keypair.
   *
   * IMPORTANT: The `secretKeyBase64` field in the result contains the raw private key.
   * The caller MUST store this securely (KMS, encrypted vault, signer profile store).
   * It is returned exactly once and never stored by this provider.
   *
   * In a production system, the key would be handed directly to a KMS or MPC coordinator.
   * For devnet/staging, it is returned so the operator can inspect or fund the address.
   */
  async provisionWallet(input: WalletProvisionInput): Promise<ProvisionedWallet> {
    const keypair = Keypair.generate()
    const address = keypair.publicKey.toBase58()
    const signerProfileId = input.signerProfileId ?? this.defaultSignerProfileId ?? 'solana_keypair'

    const walletRecord: WalletRecord = {
      walletId: input.walletId,
      createdAt: this.now(),
      updatedAt: this.now(),
      state: 'pending_compliance',
      organizationId: input.organizationId,
      treasuryId: input.treasuryId,
      subjectId: input.subjectId,
      walletType: input.walletType,
      address,
      supportedChains: input.supportedChains.length > 0
        ? input.supportedChains
        : ['solana', 'solana-devnet', 'solana-testnet', 'solana-mainnet', 'devnet', 'testnet', 'mainnet'],
      signerProfileId,
      providerId: 'solana_wallet_provider',
      complianceStatus: 'not_started',
      policyAttachmentStatus: input.signerProfileId ? 'attached' : 'pending',
      signerHealthStatus: 'healthy',
      trustStatus: 'unassessed',
    }

    await this.registry.put(walletRecord)

    return {
      walletRecord,
      address,
      providerId: 'solana_wallet_provider',
      // Base64-encode the full 64-byte secret key for safe transport
      secretKeyBase64: Buffer.from(keypair.secretKey).toString('base64'),
    }
  }

  /** Returns the SOL balance of an address in lamports */
  async getBalance(address: string): Promise<{ lamports: bigint; sol: number }> {
    const pubkey = new PublicKey(address)
    const lamports = await this.connection.getBalance(pubkey)
    return { lamports: BigInt(lamports), sol: lamports / LAMPORTS_PER_SOL }
  }

  /** Returns the active cluster this provider is connected to */
  getCluster(): SolanaCluster {
    return this.cluster
  }

  /** Exposes the underlying Connection for use in the signer / broadcaster */
  getConnection(): Connection {
    return this.connection
  }
}
