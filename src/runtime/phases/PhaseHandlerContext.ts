import type { RuntimeActor } from '../../contracts/common.js'
import type { ArtifactRef } from '../../contracts/ledger.js'
import type { LedgerRefs } from '../../contracts/ledger.js'
import type { PolicyProfile } from '../../contracts/policy.js'
import type { PolicyResolver } from '../../contracts/policyResolution.js'
import type { ApprovalEngine } from '../../contracts/approval.js'
import type { SimulationEngine } from '../../contracts/simulation.js'
import type { SignerGateway } from '../../contracts/signing.js'
import type { TrustEngine } from '../../contracts/trust.js'
import type { ComplianceProvider } from '../../contracts/compliance.js'
import type { WalletRegistry } from '../../wallets/WalletRegistry.js'
import type { WalletProvider } from '../../contracts/wallet.js'
import type { Broadcaster } from '../../contracts/broadcast.js'
import type { Reconciler } from '../../contracts/reconciliation.js'
import type { KernelPersistence } from '../kernelPersistence.js'
import type { RunRegistry } from '../runRegistry.js'
import type { SignerProfileRegistry } from '../../signing/SignerProfileRegistry.js'
import type {
  KernelInput,
  RunState,
  SessionState,
} from '../../contracts/runtime.js'

export interface PhaseHandlerContext {
  now: () => string
  createId: (prefix: string) => string
  runs: RunRegistry
  persistence: KernelPersistence
  policyResolver: PolicyResolver
  approvalEngine: ApprovalEngine
  simulationEngine: SimulationEngine
  signerGateway: SignerGateway
  signerProfiles: SignerProfileRegistry
  trustEngine: TrustEngine
  complianceProvider: ComplianceProvider
  walletRegistry: WalletRegistry
  walletProvider: WalletProvider
  broadcaster: Broadcaster
  reconciler: Reconciler
  getPolicyCandidates: (input: {
    session: SessionState
    run: RunState
    kernelInput: KernelInput
  }) => Promise<PolicyProfile[]>
  appendLedgerEvent: (event: {
    eventType: string
    at: string
    runId: string
    sessionId: string
    phase: RunState['currentPhase']
    actor: RuntimeActor
    refs: LedgerRefs
    summary: string
    payload: Record<string, unknown>
    artifactRefs?: ArtifactRef[]
  }) => Promise<void>
  transitionRunPhase: (
    run: RunState,
    to: RunState['currentPhase'],
    input: {
      at: string
      actor: RuntimeActor
      reason: string
      status?: RunState['status']
      context: Record<string, unknown>
      payload?: Record<string, unknown>
    },
  ) => Promise<RunState>
  readArtifactJson: <T>(path?: string) => Promise<T | undefined>
  getRunRefs: (run: RunState) => LedgerRefs
  getSessionActor: (session: SessionState) => RuntimeActor
}
