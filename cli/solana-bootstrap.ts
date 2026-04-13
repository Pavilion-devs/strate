/**
 * solana-bootstrap.ts
 *
 * Bootstraps a SessionKernel wired with real Solana adapters:
 *   - SolanaWalletProvider  (resolves wallet addresses on-chain)
 *   - SolanaSignerGateway   (signs + submits transactions with a real Keypair)
 *   - SolanaBroadcaster     (verifies on-chain confirmation)
 *
 * Keypair loading priority:
 *   1. SOLANA_PRIVATE_KEY env var  — base58-encoded private key
 *   2. SOLANA_KEYPAIR_PATH env var — path to a JSON keypair file (Solana CLI format)
 *   3. Auto-generate a fresh keypair and print the public key (devnet only)
 *
 * Cluster: SOLANA_CLUSTER env var — 'devnet' | 'mainnet-beta' | 'testnet' | 'localnet'
 * RPC:     SOLANA_RPC_URL env var  — optional custom RPC endpoint
 *
 * Usage:
 *   bun run cli:solana
 *
 * For devnet testing with a funded wallet:
 *   solana-keygen new --outfile /tmp/devnet-wallet.json
 *   solana airdrop 2 <pubkey> --url devnet
 *   SOLANA_KEYPAIR_PATH=/tmp/devnet-wallet.json bun run cli:solana
 */

import { Keypair, Connection, clusterApiUrl } from '@solana/web3.js'
import { readFileSync, existsSync } from 'fs'
import { DefaultSessionKernel } from '../src/runtime/SessionKernel.js'
import { FileKernelPersistence } from '../src/runtime/kernelPersistence.js'
import { FileRunRegistry } from '../src/runtime/runRegistry.js'
import { SolanaWalletProvider, type SolanaCluster } from '../src/wallets/SolanaWalletProvider.js'
import { SolanaSignerGateway } from '../src/signing/SolanaSignerGateway.js'
import { SolanaBroadcaster } from '../src/broadcast/SolanaBroadcaster.js'
import { SignerProfileRegistry } from '../src/signing/SignerProfileRegistry.js'
import { FileWalletRegistry } from '../src/wallets/WalletRegistry.js'
import { buildDevPolicy, type BootstrapResult } from './bootstrap.js'
import type { SessionState, SessionKernel } from '../src/contracts/runtime.js'
import type { SignerProfile } from '../src/contracts/signerProfile.js'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export type SolanaBootstrapResult = BootstrapResult & {
  keypair: Keypair
  cluster: SolanaCluster
  walletAddress: string
  rpcUrl: string
  keypairSource: string
}

// ── Keypair loading ──────────────────────────────────────────────────────────

function loadKeypairFromBase58(raw: string): Keypair {
  // bs58 decode — @solana/web3.js exposes it via Keypair.fromSecretKey
  const bytes = Buffer.from(raw, 'base64')
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes)
  // Try base58 by treating it as a JSON array fallback
  throw new Error('SOLANA_PRIVATE_KEY must be a base64-encoded 64-byte secret key.')
}

function loadKeypairFromFile(filePath: string): Keypair {
  if (!existsSync(filePath)) {
    throw new Error(`Keypair file not found: ${filePath}`)
  }
  const raw = readFileSync(filePath, 'utf8')
  const bytes = Uint8Array.from(JSON.parse(raw) as number[])
  return Keypair.fromSecretKey(bytes)
}

function resolveKeypair(cluster: SolanaCluster): { keypair: Keypair; source: string } {
  const privateKeyEnv = process.env['SOLANA_PRIVATE_KEY']
  if (privateKeyEnv) {
    return { keypair: loadKeypairFromBase58(privateKeyEnv), source: 'SOLANA_PRIVATE_KEY env' }
  }

  const keypairPath = process.env['SOLANA_KEYPAIR_PATH']
  if (keypairPath) {
    return { keypair: loadKeypairFromFile(keypairPath), source: keypairPath }
  }

  // Auto-generate — only safe for devnet/localnet
  if (cluster === 'mainnet-beta') {
    throw new Error(
      'No keypair configured for mainnet-beta. Set SOLANA_PRIVATE_KEY or SOLANA_KEYPAIR_PATH.',
    )
  }

  const keypair = Keypair.generate()
  return { keypair, source: 'auto-generated (devnet)' }
}

// ── Signer profile ───────────────────────────────────────────────────────────

function buildSolanaSignerProfile(
  keypairPublicKey: string,
  cluster: SolanaCluster,
): SignerProfile {
  return {
    signerProfileId: 'solana_keypair',
    signerClass: 'mpc',
    adapterId: 'solana_signer_gateway',
    accountRefs: { accountAddress: keypairPublicKey },
    // Include both canonical forms and shorthand aliases users commonly type
    supportedChains: [
      'solana', 'solana-devnet', 'solana-testnet', 'solana-mainnet',
      'devnet', 'testnet', 'mainnet',
    ],
    capabilities: {
      supportsAsyncStatus: false,
      supportsCancellation: false,
      supportsBatchSigning: false,
      returnsRawSignature: true,
      returnsSignedPayload: true,
      maySubmitDirectly: true,
      supportsPolicyMetadata: false,
    },
    authRef: `solana:keypair:${keypairPublicKey}`,
    enabled: true,
  }
}

// ── Main bootstrap ───────────────────────────────────────────────────────────

export async function bootstrapSolana(options: {
  actorId?: string
  organizationId?: string
  sessionId?: string
  skipAccountValidation?: boolean
} = {}): Promise<SolanaBootstrapResult> {
  const cluster = (process.env['SOLANA_CLUSTER'] ?? 'devnet') as SolanaCluster
  const rpcUrl = process.env['SOLANA_RPC_URL']
  const runsDir = join(__dirname, '..', 'runs')

  const { keypair, source } = resolveKeypair(cluster)
  const walletAddress = keypair.publicKey.toBase58()

  // Shared connection
  const connectionUrl = rpcUrl ?? (cluster === 'localnet'
    ? 'http://127.0.0.1:8899'
    : clusterApiUrl(cluster as 'mainnet-beta' | 'devnet' | 'testnet'))
  const connection = new Connection(connectionUrl, 'confirmed')

  // Persistence
  const persistence = new FileKernelPersistence(runsDir)
  const runRegistry = new FileRunRegistry(runsDir)

  // Registries
  const walletRegistry = new FileWalletRegistry(runsDir)
  const signerProfile = buildSolanaSignerProfile(walletAddress, cluster)
  const signerProfileRegistry = new SignerProfileRegistry([signerProfile])

  // Adapters
  const walletProvider = new SolanaWalletProvider({
    cluster,
    rpcUrl: connectionUrl,
    registry: walletRegistry,
    skipAccountValidation: options.skipAccountValidation ?? cluster !== 'mainnet-beta',
    defaultSignerProfileId: signerProfile.signerProfileId,
  })

  const signerGateway = new SolanaSignerGateway({
    keypair,
    cluster,
    connection,
  })

  const broadcaster = new SolanaBroadcaster({
    cluster,
    connection,
  })

  const orgId = options.organizationId ?? 'org_demo'
  const devPolicy = buildDevPolicy(orgId)
  // Override allowed chains to include Solana
  devPolicy.scope.allowedChains = []  // empty = all chains

  const kernel: SessionKernel = new DefaultSessionKernel({
    persistence,
    runs: runRegistry,
    walletRegistry,
    walletProvider,
    signerGateway,
    broadcaster,
    signerProfiles: signerProfileRegistry,
    getPolicyCandidates: async () => [devPolicy],
  })

  const session: SessionState = await kernel.loadOrCreateSession({
    sessionId: options.sessionId,
    mode: 'interactive',
    environment: cluster === 'mainnet-beta' ? 'production' : 'test',
    orgContext: { organizationId: orgId },
    actorContext: {
      actorId: options.actorId ?? 'operator_1',
      roleIds: ['admin', 'treasury_operator'],
    },
  })

  return {
    kernel,
    session,
    persist: true,
    runsDir,
    persistence,
    runRegistry,
    walletRegistry,
    keypair,
    cluster,
    walletAddress,
    rpcUrl: connectionUrl,
    keypairSource: source,
  }
}
