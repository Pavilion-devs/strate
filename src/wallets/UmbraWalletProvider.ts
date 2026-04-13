/**
 * UmbraWalletProvider
 *
 * WalletProvider implementation backed by the Umbra Privacy SDK.
 *
 * Design:
 * - Wraps an Umbra client (lazily initialized) for each wallet operator key.
 * - For resolving transfer sources: returns the Umbra signer's address as the
 *   source wallet, so the UmbraBroadcaster can route the transfer through the
 *   Umbra privacy layer (confidential ETA deposit or UTXO mixer).
 * - For provisioning wallets: generates a fresh in-memory signer (devnet/testing)
 *   or wraps a provided keypair (production).
 *
 * Integration contract:
 *   This provider satisfies the WalletProvider interface. The runtime does NOT need
 *   to know it is talking to Umbra — swap the concrete provider in the bootstrap
 *   file and all shielded behaviour follows automatically.
 *
 * Usage:
 *   const provider = await UmbraWalletProvider.create({
 *     network: 'devnet',
 *     rpcUrl: 'https://api.devnet.solana.com',
 *     rpcSubscriptionsUrl: 'wss://api.devnet.solana.com',
 *     secretKeyBase64: process.env['UMBRA_SECRET_KEY_BASE64'],
 *   })
 */

import {
  createInMemorySigner,
  createSignerFromPrivateKeyBytes,
  getUmbraClient,
} from '@umbra-privacy/sdk'
import type { IUmbraClient, IUmbraSigner, GetUmbraClientArgs } from '@umbra-privacy/sdk'
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

export type UmbraNetwork = 'mainnet' | 'devnet' | 'localnet'

export type UmbraWalletProviderDependencies = {
  network?: UmbraNetwork
  rpcUrl?: string
  rpcSubscriptionsUrl?: string
  /** Base64-encoded 64-byte Solana keypair or 32-byte seed. Omit to generate a fresh in-memory signer (testing). */
  secretKeyBase64?: string
  /** Pre-built signer — takes precedence over secretKeyBase64 */
  signer?: IUmbraSigner
  /** Pre-built Umbra client — skips getUmbraClient() entirely (testing) */
  client?: IUmbraClient
  registry?: WalletRegistry
  now?: () => string
  skipAccountValidation?: boolean
  defaultSignerProfileId?: string
  /** Delay master seed signature until first operation (avoids wallet prompt at construction time) */
  deferMasterSeedSignature?: boolean
}

// ─── USDC mint addresses per network ────────────────────────────────────────

const USDC_MINTS: Record<UmbraNetwork, string> = {
  mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  localnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class UmbraWalletProvider implements WalletProvider {
  private readonly network: UmbraNetwork
  private readonly registry: WalletRegistry
  private readonly now: () => string
  private readonly skipAccountValidation: boolean
  private readonly defaultSignerProfileId: string | undefined

  /** Lazily resolved Umbra client — a single shared instance per provider */
  private readonly clientPromise: Promise<IUmbraClient>

  private constructor(
    clientPromise: Promise<IUmbraClient>,
    deps: UmbraWalletProviderDependencies,
  ) {
    this.clientPromise = clientPromise
    this.network = deps.network ?? 'devnet'
    this.registry = deps.registry ?? new InMemoryWalletRegistry()
    this.now = deps.now ?? defaultNow
    this.skipAccountValidation = deps.skipAccountValidation ?? true
    this.defaultSignerProfileId = deps.defaultSignerProfileId
  }

  /**
   * Async factory — preferred entry point.
   *
   * Builds the Umbra signer (or accepts one), then kicks off the async
   * getUmbraClient() call and stores the resulting promise. The promise is
   * awaited lazily on the first provider call, so construction is synchronous
   * from the caller's perspective.
   */
  static async create(deps: UmbraWalletProviderDependencies = {}): Promise<UmbraWalletProvider> {
    let clientPromise: Promise<IUmbraClient>

    if (deps.client) {
      clientPromise = Promise.resolve(deps.client)
    } else {
      const signer = await UmbraWalletProvider.buildSigner(deps)
      const network = deps.network ?? 'devnet'
      const rpcUrl = deps.rpcUrl ?? defaultRpcUrl(network)
      const rpcSubscriptionsUrl = deps.rpcSubscriptionsUrl ?? defaultWsUrl(network)

      const args: GetUmbraClientArgs = {
        signer,
        network,
        rpcUrl,
        rpcSubscriptionsUrl,
        ...(deps.deferMasterSeedSignature !== undefined
          ? { deferMasterSeedSignature: deps.deferMasterSeedSignature }
          : {}),
      }
      clientPromise = getUmbraClient(args)
    }

    return new UmbraWalletProvider(clientPromise, deps)
  }

  /** Exposes the Umbra client promise for use in UmbraBroadcaster and ViewingKeyLedgerExtension */
  async getClient(): Promise<IUmbraClient> {
    return this.clientPromise
  }

  /** Returns the USDC mint for the current network */
  getUsdcMint(): string {
    return USDC_MINTS[this.network]
  }

  // ── WalletProvider interface ──────────────────────────────────────────────

  async resolveTransferSource(
    input: WalletProviderResolutionInput,
  ): Promise<ResolvedTransferSourceWallet> {
    const client = await this.clientPromise
    const address = client.signer.address as string

    const existing = await this.registry.get(input.walletId)
    const signerProfileId =
      existing?.signerProfileId ??
      this.defaultSignerProfileId ??
      'umbra_signer'

    const walletRecord: WalletRecord =
      existing ?? {
        walletId: input.walletId,
        createdAt: this.now(),
        updatedAt: this.now(),
        state: 'active_full',
        walletType: 'ops',
        address,
        supportedChains: ['solana', 'solana-devnet', 'solana-testnet', 'devnet', 'testnet'],
        signerProfileId,
        providerId: 'umbra_wallet_provider',
        complianceStatus: 'approved',
        policyAttachmentStatus: 'attached',
        signerHealthStatus: 'healthy',
        trustStatus: 'sufficient',
      }

    if (!existing) {
      await this.registry.put(walletRecord)
    }

    const signerClass = input.requiredSignerClass ?? input.allowedSignerClasses?.[0] ?? 'mpc'

    return {
      providerId: 'umbra_wallet_provider',
      wallet: walletRecord,
      address,
      signerProfileId,
      signerClass,
      supportedChains: walletRecord.supportedChains ?? ['solana'],
    }
  }

  async provisionWallet(input: WalletProvisionInput): Promise<ProvisionedWallet> {
    // Generate a fresh in-memory signer for the new wallet.
    // In production, this would be a hardware or MPC signer registered with Umbra.
    const signer = await createInMemorySigner()
    const address = signer.address as string
    const signerProfileId = input.signerProfileId ?? this.defaultSignerProfileId ?? 'umbra_signer'

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
      supportedChains:
        input.supportedChains.length > 0
          ? input.supportedChains
          : ['solana', 'solana-devnet', 'devnet'],
      signerProfileId,
      providerId: 'umbra_wallet_provider',
      complianceStatus: 'not_started',
      policyAttachmentStatus: input.signerProfileId ? 'attached' : 'pending',
      signerHealthStatus: 'healthy',
      trustStatus: 'unassessed',
    }

    await this.registry.put(walletRecord)

    return {
      walletRecord,
      address,
      providerId: 'umbra_wallet_provider',
      // Note: in-memory signers do not expose raw secret key bytes via the IUmbraSigner interface.
      // Store the signer profile separately in production (KMS, etc.).
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private static async buildSigner(
    deps: UmbraWalletProviderDependencies,
  ): Promise<IUmbraSigner> {
    if (deps.signer) return deps.signer

    if (deps.secretKeyBase64) {
      const keyBytes = Buffer.from(deps.secretKeyBase64, 'base64')
      return createSignerFromPrivateKeyBytes(new Uint8Array(keyBytes))
    }

    // No key provided — generate a fresh ephemeral signer (suitable for testing)
    return createInMemorySigner()
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function defaultRpcUrl(network: UmbraNetwork): string {
  switch (network) {
    case 'mainnet': return 'https://api.mainnet-beta.solana.com'
    case 'devnet': return 'https://api.devnet.solana.com'
    case 'localnet': return 'http://127.0.0.1:8899'
  }
}

function defaultWsUrl(network: UmbraNetwork): string {
  switch (network) {
    case 'mainnet': return 'wss://api.mainnet-beta.solana.com'
    case 'devnet': return 'wss://api.devnet.solana.com'
    case 'localnet': return 'ws://127.0.0.1:8900'
  }
}
