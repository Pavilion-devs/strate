/**
 * umbra-bootstrap.ts
 *
 * Wires together a DefaultSessionKernel with Umbra privacy adapters:
 *   - UmbraWalletProvider  →  replaces SolanaWalletProvider
 *   - UmbraBroadcaster     →  replaces SolanaBroadcaster
 *   - ViewingKeyLedgerExtension  →  attached for compliance disclosure
 *
 * All standard policy/approval/simulation/signing behaviour is unchanged.
 * Umbra slots in transparently at the wallet + broadcast layer.
 *
 * Usage:
 *   const { kernel, session, umbraProvider, viewingKeyLedger } = await bootstrapUmbra({
 *     network: 'devnet',
 *     rpcUrl: 'https://api.devnet.solana.com',
 *     rpcSubscriptionsUrl: 'wss://api.devnet.solana.com',
 *     secretKeyBase64: process.env['UMBRA_SECRET_KEY_BASE64'],
 *   })
 *
 * Note: UmbraWalletProvider.create() is async because it calls getUmbraClient().
 * With deferMasterSeedSignature: true the wallet-sign prompt is deferred until
 * the first actual operation, so construction does not block.
 */

import { DefaultSessionKernel } from '../src/runtime/SessionKernel.js'
import {
  InMemoryKernelPersistence,
  FileKernelPersistence,
  type KernelPersistence,
} from '../src/runtime/kernelPersistence.js'
import type { SessionState, SessionKernel } from '../src/contracts/runtime.js'
import type { PolicyProfile } from '../src/contracts/policy.js'
import {
  InMemoryRunRegistry,
  FileRunRegistry,
  type RunRegistry,
} from '../src/runtime/runRegistry.js'
import {
  InMemoryWalletRegistry,
  FileWalletRegistry,
  type WalletRegistry,
} from '../src/wallets/WalletRegistry.js'
import {
  UmbraWalletProvider,
  type UmbraNetwork,
} from '../src/wallets/UmbraWalletProvider.js'
import { UmbraBroadcaster } from '../src/broadcast/UmbraBroadcaster.js'
import { ViewingKeyLedgerExtension } from '../src/ledger/ViewingKeyLedgerExtension.js'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ─── Umbra-aware dev policy ───────────────────────────────────────────────────

export function buildUmbraDevPolicy(organizationId = 'org_demo'): PolicyProfile {
  const now = new Date().toISOString()
  return {
    policyProfileId: 'umbra_dev_permissive',
    version: '1',
    createdAt: now,
    updatedAt: now,
    owner: { organizationId },
    mode: 'copilot',
    scope: {
      environments: ['test', 'staging', 'production'],
      allowedChains: [],
      allowedAssets: [],
    },
    permissions: {
      actions: {
        'asset.transfer': {
          enabled: true,
          allowedSignerClasses: ['mpc', 'multisig', 'smart_account', 'custodial', 'hardware_service'],
        },
        'wallet.create': { enabled: true },
        'treasury.rebalance': { enabled: true },
        'treasury.payment_batch': { enabled: true },
        'wallet.policy_update': { enabled: true },
        'identity.start_kyc': { enabled: true },
        'governance.vote': { enabled: true },
        'counterparty.whitelist': { enabled: true },
      },
      counterparty: {},
      protocols: {},
      signer: {
        allowedSignerClasses: ['mpc', 'multisig', 'smart_account', 'custodial', 'hardware_service'],
      },
      simulation: {},
    },
    approvals: {
      'asset.transfer': {
        autoApproveUnder: '10000',
        singleApprovalUnder: '100000',
      },
    },
    identity: {},
    trust: {},
    emergency: { emergencyHaltEnabled: false },
    // Umbra-specific: confidential transfers by default, viewing keys always retained
    umbra: {
      defaultPath: 'confidential',
      mixerRequired: false,
      viewingKeyRetention: 'always',
      disclosureRecipients: [],
    },
  }
}

// ─── Bootstrap result ─────────────────────────────────────────────────────────

export type UmbraBootstrapResult = {
  kernel: SessionKernel
  session: SessionState
  persist: boolean
  runsDir: string | null
  persistence: KernelPersistence
  runRegistry: RunRegistry
  walletRegistry: WalletRegistry
  umbraProvider: UmbraWalletProvider
  umbraBroadcaster: UmbraBroadcaster
  viewingKeyLedger: ViewingKeyLedgerExtension
}

// ─── Bootstrap function ───────────────────────────────────────────────────────

export async function bootstrapUmbra(options: {
  network?: UmbraNetwork
  rpcUrl?: string
  rpcSubscriptionsUrl?: string
  secretKeyBase64?: string
  persist?: boolean
  actorId?: string
  organizationId?: string
  sessionId?: string
} = {}): Promise<UmbraBootstrapResult> {
  const network: UmbraNetwork = options.network ?? 'devnet'
  const persist = options.persist ?? false
  const runsDir = persist ? join(__dirname, '..', 'runs') : null
  const orgId = options.organizationId ?? 'org_demo'

  // ── Build Umbra adapters ────────────────────────────────────────────────────

  const umbraProvider = await UmbraWalletProvider.create({
    network,
    rpcUrl: options.rpcUrl,
    rpcSubscriptionsUrl: options.rpcSubscriptionsUrl,
    secretKeyBase64: options.secretKeyBase64,
    // Defer the wallet-sign master-seed prompt until first actual operation
    deferMasterSeedSignature: true,
  })

  const umbraBroadcaster = new UmbraBroadcaster({
    walletProvider: umbraProvider,
    network,
  })

  const viewingKeyLedger = new ViewingKeyLedgerExtension({
    walletProvider: umbraProvider,
  })

  // ── Build kernel ────────────────────────────────────────────────────────────

  const devPolicy = buildUmbraDevPolicy(orgId)

  let kernel: SessionKernel
  let persistence: KernelPersistence
  let runRegistry: RunRegistry
  let walletRegistry: WalletRegistry

  if (persist && runsDir) {
    persistence = new FileKernelPersistence(runsDir)
    runRegistry = new FileRunRegistry(runsDir)
    walletRegistry = new FileWalletRegistry(runsDir)
  } else {
    persistence = new InMemoryKernelPersistence()
    runRegistry = new InMemoryRunRegistry()
    walletRegistry = new InMemoryWalletRegistry()
  }

  kernel = new DefaultSessionKernel({
    persistence,
    runs: runRegistry,
    walletRegistry,
    walletProvider: umbraProvider,
    broadcaster: umbraBroadcaster,
    getPolicyCandidates: async () => [devPolicy],
  })

  const session = await kernel.loadOrCreateSession({
    sessionId: options.sessionId,
    mode: 'interactive',
    environment: 'test',
    orgContext: { organizationId: orgId },
    actorContext: {
      actorId: options.actorId ?? 'operator_1',
      roleIds: ['admin', 'treasury_operator'],
    },
  })

  return {
    kernel,
    session,
    persist,
    runsDir,
    persistence,
    runRegistry,
    walletRegistry,
    umbraProvider,
    umbraBroadcaster,
    viewingKeyLedger,
  }
}
