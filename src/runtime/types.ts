import type { KernelMode } from '../contracts/runtime.js'
import type { PolicyProfile } from '../contracts/policy.js'
import type { PolicyResolver } from '../contracts/policyResolution.js'
import type { ApprovalEngine } from '../contracts/approval.js'
import type { Broadcaster } from '../contracts/broadcast.js'
import type { ComplianceProvider } from '../contracts/compliance.js'
import type { WalletProvider } from '../contracts/wallet.js'
import type {
  KernelInput,
  RunState,
  SessionState,
} from '../contracts/runtime.js'
import type { Reconciler } from '../contracts/reconciliation.js'
import type { SignerGateway } from '../contracts/signing.js'
import type { SimulationEngine } from '../contracts/simulation.js'
import type { TrustEngine } from '../contracts/trust.js'
import type { SignerProfileRegistry } from '../signing/SignerProfileRegistry.js'
import type { KernelPersistence } from './kernelPersistence.js'
import type { RunRegistry } from './runRegistry.js'
import type { SessionRegistry } from './sessionRegistry.js'
import type { WalletRegistry } from '../wallets/WalletRegistry.js'

export type SessionKernelDependencies = {
  sessions?: SessionRegistry
  runs?: RunRegistry
  persistence?: KernelPersistence
  policyResolver?: PolicyResolver
  approvalEngine?: ApprovalEngine
  simulationEngine?: SimulationEngine
  signerGateway?: SignerGateway
  signerProfiles?: SignerProfileRegistry
  trustEngine?: TrustEngine
  complianceProvider?: ComplianceProvider
  walletRegistry?: WalletRegistry
  walletProvider?: WalletProvider
  broadcaster?: Broadcaster
  reconciler?: Reconciler
  getPolicyCandidates?: (input: {
    session: SessionState
    run: RunState
    kernelInput: KernelInput
  }) => Promise<PolicyProfile[]>
  now?: () => string
  createId?: (prefix: string) => string
  defaultMode?: KernelMode
}

export function defaultNow(): string {
  return new Date().toISOString()
}

export function defaultIdGenerator(prefix: string): string {
  const time = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 10)
  return `${prefix}_${time}_${random}`
}
