/**
 * bootstrap.ts
 *
 * Wires together a DefaultSessionKernel with all deterministic dependencies
 * and returns a live session ready for operator input.
 *
 * Pass `persist: true` to use file-backed storage under ./runs/
 * Pass `persist: false` (default) for pure in-memory mode.
 */

import { DefaultSessionKernel } from '../src/runtime/SessionKernel.js'
import {
  FileKernelPersistence,
  InMemoryKernelPersistence,
  type KernelPersistence,
} from '../src/runtime/kernelPersistence.js'
import type { SessionState } from '../src/contracts/runtime.js'
import type { SessionKernel } from '../src/contracts/runtime.js'
import type { PolicyProfile } from '../src/contracts/policy.js'
import {
  FileRunRegistry,
  InMemoryRunRegistry,
  type RunRegistry,
} from '../src/runtime/runRegistry.js'
import {
  FileWalletRegistry,
  InMemoryWalletRegistry,
  type WalletRegistry,
} from '../src/wallets/WalletRegistry.js'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export type BootstrapResult = {
  kernel: SessionKernel
  session: SessionState
  persist: boolean
  runsDir: string | null
  persistence: KernelPersistence
  runRegistry: RunRegistry
  walletRegistry: WalletRegistry
}

/**
 * A permissive development policy that allows all actions on all chains.
 * Only for local dev and smoke tests — never for production.
 */
export function buildDevPolicy(organizationId = 'org_demo'): PolicyProfile {
  const now = new Date().toISOString()
  return {
    policyProfileId: 'dev_permissive',
    version: '1',
    createdAt: now,
    updatedAt: now,
    owner: { organizationId },
    mode: 'copilot',
    scope: {
      environments: ['test', 'staging', 'production'],
      allowedChains: [],    // empty = all chains allowed
      allowedAssets: [],    // empty = all assets allowed
    },
    permissions: {
      actions: {
        'asset.transfer': { enabled: true, allowedSignerClasses: ['mpc', 'multisig', 'smart_account', 'custodial', 'hardware_service'] },
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
      signer: { allowedSignerClasses: ['mpc', 'multisig', 'smart_account', 'custodial', 'hardware_service'] },
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
  }
}

export async function bootstrap(options: {
  persist?: boolean
  actorId?: string
  organizationId?: string
  sessionId?: string
  useDevPolicy?: boolean
} = {}): Promise<BootstrapResult> {
  const persist = options.persist ?? false
  const runsDir = persist
    ? join(__dirname, '..', 'runs')
    : null

  const orgId = options.organizationId ?? 'org_demo'
  const devPolicy = buildDevPolicy(orgId)

  let kernel: SessionKernel
  let persistence: KernelPersistence
  let runRegistry: RunRegistry
  let walletRegistry: WalletRegistry

  if (persist && runsDir) {
    persistence = new FileKernelPersistence(runsDir)
    runRegistry = new FileRunRegistry(runsDir)
    walletRegistry = new FileWalletRegistry(runsDir)
    kernel = new DefaultSessionKernel({
      persistence,
      runs: runRegistry,
      walletRegistry,
      getPolicyCandidates: async () => (options.useDevPolicy !== false ? [devPolicy] : []),
    })
  } else {
    persistence = new InMemoryKernelPersistence()
    runRegistry = new InMemoryRunRegistry()
    walletRegistry = new InMemoryWalletRegistry()
    kernel = new DefaultSessionKernel({
      persistence,
      runs: runRegistry,
      walletRegistry,
      getPolicyCandidates: async () => (options.useDevPolicy !== false ? [devPolicy] : []),
    })
  }

  const session = await kernel.loadOrCreateSession({
    sessionId: options.sessionId,
    mode: 'interactive',
    environment: 'test',
    orgContext: {
      organizationId: options.organizationId ?? 'org_demo',
    },
    actorContext: {
      actorId: options.actorId ?? 'operator_1',
      roleIds: ['admin', 'treasury_operator'],
    },
  })

  return { kernel, session, persist, runsDir, persistence, runRegistry, walletRegistry }
}
