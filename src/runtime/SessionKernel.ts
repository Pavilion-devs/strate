import type { RuntimeActor } from '../contracts/common.js'
import type { ApprovalState } from '../contracts/approval.js'
import type { ApprovalReviewPackage } from '../contracts/approvalReview.js'
import type { ArtifactRef, LedgerRefs } from '../contracts/ledger.js'
import type { IntentActionType } from '../contracts/intent.js'
import type { PolicyProfile } from '../contracts/policy.js'
import type { PolicyResolver } from '../contracts/policyResolution.js'
import type { ApprovalEngine } from '../contracts/approval.js'
import type { SimulationEngine } from '../contracts/simulation.js'
import type { SignerGateway } from '../contracts/signing.js'
import type { TrustEngine } from '../contracts/trust.js'
import type { ComplianceProvider } from '../contracts/compliance.js'
import type { WalletProvider } from '../contracts/wallet.js'
import type { Broadcaster } from '../contracts/broadcast.js'
import type { Reconciler } from '../contracts/reconciliation.js'
import type {
  KernelBootstrapInput,
  KernelCallbackEvent,
  KernelInput,
  KernelInputKind,
  KernelTurnResult,
  RunState,
  SessionKernel,
  SessionState,
  TranscriptEntry,
} from '../contracts/runtime.js'
import { classifyKernelInput, detectRequestedActionType } from './inputClassifier.js'
import {
  FileKernelPersistence,
  InMemoryKernelPersistence,
  type KernelPersistence,
} from './kernelPersistence.js'
import {
  assertPhaseTransition,
  type PhaseTransitionContext,
} from './phaseGuards.js'
import { InMemoryRunRegistry, type RunRegistry } from './runRegistry.js'
import {
  defaultIdGenerator,
  defaultNow,
  type SessionKernelDependencies,
} from './types.js'
import {
  InMemorySessionRegistry,
  type SessionRegistry,
} from './sessionRegistry.js'
import { RestrictivePolicyResolver } from '../policy/RestrictivePolicyResolver.js'
import { DeterministicApprovalEngine } from '../approval/DeterministicApprovalEngine.js'
import { DeterministicComplianceProvider } from '../compliance/DeterministicComplianceProvider.js'
import { DeterministicSimulationEngine } from '../simulation/DeterministicSimulationEngine.js'
import { DeterministicBroadcaster } from '../broadcast/DeterministicBroadcaster.js'
import { DeterministicReconciler } from '../reconciliation/DeterministicReconciler.js'
import { DeterministicSignerGateway } from '../signing/DeterministicSignerGateway.js'
import { DeterministicTrustEngine } from '../trust/TrustEngine.js'
import {
  createDefaultSignerProfiles,
  SignerProfileRegistry,
} from '../signing/SignerProfileRegistry.js'
import { PersistentSignerProfileRegistry } from '../signing/PersistentSignerProfileRegistry.js'
import { AIKernelRouter } from './AIKernelRouter.js'
import { StatusQueryEngine } from './StatusQueryEngine.js'
import { DeterministicWalletProvider } from '../wallets/DeterministicWalletProvider.js'
import {
  FileWalletRegistry,
  InMemoryWalletRegistry,
  type WalletRegistry,
} from '../wallets/WalletRegistry.js'
import { readFile } from 'fs/promises'
import type { PhaseHandlerContext } from './phases/PhaseHandlerContext.js'
import { TransferPhaseHandler } from './phases/TransferPhaseHandler.js'
import { WalletCreatePhaseHandler } from './phases/WalletCreatePhaseHandler.js'
import { TreasuryPhaseHandler } from './phases/TreasuryPhaseHandler.js'
import { PaymentBatchPhaseHandler } from './phases/PaymentBatchPhaseHandler.js'
import { SigningBroadcastHandler } from './phases/SigningBroadcastHandler.js'
import { ApprovalPackageHandler } from './phases/ApprovalPackageHandler.js'

type ResolvedDependencies = {
  sessions: SessionRegistry
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
  now: () => string
  createId: (prefix: string) => string
}

export class DefaultSessionKernel implements SessionKernel {
  private readonly deps: ResolvedDependencies
  private readonly transferHandler: TransferPhaseHandler
  private readonly walletCreateHandler: WalletCreatePhaseHandler
  private readonly treasuryHandler: TreasuryPhaseHandler
  private readonly paymentBatchHandler: PaymentBatchPhaseHandler
  private readonly signingBroadcastHandler: SigningBroadcastHandler
  private readonly approvalPackageHandler: ApprovalPackageHandler

  constructor(dependencies: SessionKernelDependencies = {}) {
    const now = dependencies.now ?? defaultNow
    const createId = dependencies.createId ?? defaultIdGenerator
    const persistence =
      dependencies.persistence ?? new InMemoryKernelPersistence()
    const signerProfiles =
      dependencies.signerProfiles ??
      (persistence instanceof FileKernelPersistence
        ? new PersistentSignerProfileRegistry({
            baseDir: persistence.baseDir,
            seedProfiles: createDefaultSignerProfiles(),
          })
        : new SignerProfileRegistry(createDefaultSignerProfiles()))
    const walletRegistry =
      dependencies.walletRegistry ??
      (persistence instanceof FileKernelPersistence
        ? new FileWalletRegistry(persistence.baseDir)
        : new InMemoryWalletRegistry())

    this.deps = {
      sessions: dependencies.sessions ?? new InMemorySessionRegistry(),
      runs: dependencies.runs ?? new InMemoryRunRegistry(),
      persistence,
      policyResolver:
        dependencies.policyResolver ??
        new RestrictivePolicyResolver({
          now,
        }),
      approvalEngine:
        dependencies.approvalEngine ??
        new DeterministicApprovalEngine({
          now,
          createId,
        }),
      simulationEngine:
        dependencies.simulationEngine ??
        new DeterministicSimulationEngine({
          now,
          createId,
        }),
      signerGateway:
        dependencies.signerGateway ?? new DeterministicSignerGateway('pending'),
      signerProfiles,
      trustEngine:
        dependencies.trustEngine ??
        new DeterministicTrustEngine({
          wallets: walletRegistry,
          now,
          createId,
        }),
      complianceProvider:
        dependencies.complianceProvider ?? new DeterministicComplianceProvider(),
      walletRegistry,
      walletProvider:
        dependencies.walletProvider ??
        new DeterministicWalletProvider({
          now,
          registry: walletRegistry,
        }),
      broadcaster:
        dependencies.broadcaster ??
        new DeterministicBroadcaster({
          now,
          createId,
        }),
      reconciler:
        dependencies.reconciler ??
        new DeterministicReconciler({
          now,
          createId,
        }),
      getPolicyCandidates: dependencies.getPolicyCandidates ?? (async () => []),
      now,
      createId,
    }

    const ctx: PhaseHandlerContext = {
      ...this.deps,
      appendLedgerEvent: this.appendLedgerEvent.bind(this),
      transitionRunPhase: this.transitionRunPhase.bind(this),
      readArtifactJson: this.readArtifactJson.bind(this),
      getRunRefs: this.getRunRefs.bind(this),
      getSessionActor: this.getSessionActor.bind(this),
    }

    this.approvalPackageHandler = new ApprovalPackageHandler(ctx)
    this.signingBroadcastHandler = new SigningBroadcastHandler(ctx)
    this.transferHandler = new TransferPhaseHandler(ctx)
    this.walletCreateHandler = new WalletCreatePhaseHandler(ctx)
    this.treasuryHandler = new TreasuryPhaseHandler(ctx)
    this.paymentBatchHandler = new PaymentBatchPhaseHandler(ctx)

    // Wire cross-handler references
    this.signingBroadcastHandler.setApprovalPackageHandler(this.approvalPackageHandler)
    this.signingBroadcastHandler.setTransferHandler(this.transferHandler)
    this.signingBroadcastHandler.setPaymentBatchHandler(this.paymentBatchHandler)

    this.transferHandler.setSigningBroadcastHandler(this.signingBroadcastHandler)
    this.transferHandler.setApprovalPackageHandler(this.approvalPackageHandler)

    this.treasuryHandler.setSigningBroadcastHandler(this.signingBroadcastHandler)
    this.treasuryHandler.setApprovalPackageHandler(this.approvalPackageHandler)

    this.paymentBatchHandler.setSigningBroadcastHandler(this.signingBroadcastHandler)
    this.paymentBatchHandler.setApprovalPackageHandler(this.approvalPackageHandler)
  }

  async loadOrCreateSession(
    input: KernelBootstrapInput,
  ): Promise<SessionState> {
    if (input.sessionId) {
      const existing = await this.deps.sessions.get(input.sessionId)
      if (existing) {
        return this.normalizeSession(existing)
      }
    }

    const createdAt = this.deps.now()
    const sessionId = input.sessionId ?? this.deps.createId('session')
    const session: SessionState = {
      sessionId,
      createdAt,
      updatedAt: createdAt,
      mode: input.mode,
      environment: input.environment,
      orgContext: input.orgContext,
      actorContext: input.actorContext,
      runIds: [],
      pendingApprovalRunIds: [],
      pendingSignatureRunIds: [],
      pendingConfirmationRunIds: [],
      halted: false,
      transcriptRef: input.transcriptRef ?? `session:${sessionId}:transcript`,
    }

    await this.deps.sessions.put(session)
    await this.appendTranscript({
      entryId: this.deps.createId('entry'),
      at: createdAt,
      sessionId,
      role: 'system',
      content: `Session ${sessionId} created in ${input.mode} mode.`,
    })

    return session
  }

  async handleInput(input: KernelInput): Promise<KernelTurnResult> {
    const session = await this.requireSession(input.sessionId)

    // If the input has raw text and no pre-classified kind, run the AI router first.
    // It returns a structured kind + payload so the rest of the kernel gets clean data.
    let enrichedInput = input
    if (input.text && !input.kind && !input.requestedActionType && !input.payload?.callbackEvent) {
      const router = new AIKernelRouter()
      const routerResult = await router.route(input.text, {
        // Pass any partial hints already present in payload (e.g. sourceWalletId from CLI)
        ...(input.payload ?? {}),
      })

      if (routerResult.kind === 'action_request') {
        enrichedInput = {
          ...input,
          kind: 'action_request',
          requestedActionType: routerResult.actionType,
          // Merge AI-extracted payload with any CLI-injected hints (CLI wins for sourceWalletId)
          payload: { ...routerResult.payload, ...(input.payload ?? {}) },
        }
      } else if (routerResult.kind === 'status_query') {
        enrichedInput = { ...input, kind: 'status_query' }
      } else if (routerResult.kind === 'operator_command') {
        enrichedInput = {
          ...input,
          kind: 'operator_command',
          payload: { ...input.payload, command: routerResult.command },
        }
      }
      // conversational → leave as-is, regex classifier will handle or pass through
    }

    const kind = classifyKernelInput(enrichedInput)
    const receivedAt = enrichedInput.receivedAt ?? this.deps.now()

    await this.appendTranscript({
      entryId: this.deps.createId('entry'),
      at: receivedAt,
      sessionId: session.sessionId,
      runId: enrichedInput.runId,
      role: 'operator',
      content: enrichedInput.text ?? `[${kind}]`,
    })

    switch (kind) {
      case 'action_request':
        return this.handleActionRequest(session, enrichedInput, kind, receivedAt)
      case 'resume_signal':
        return this.handleResumeSignal(session, enrichedInput, kind)
      case 'status_query':
        return this.handleStatusQuery(session, enrichedInput, kind)
      case 'operator_command':
        return this.handleOperatorCommand(session, enrichedInput, kind)
      case 'callback_event':
        if (enrichedInput.payload?.callbackEvent) {
          await this.ingestCallback(
            enrichedInput.payload.callbackEvent as KernelCallbackEvent,
          )
        }
        return this.finalizeTurn(session, kind, ['Processed callback event.'])
      case 'conversational':
      default:
        return this.finalizeTurn(session, kind, [
          'Input captured without creating a run.',
        ])
    }
  }

  async resumeRun(runId: string): Promise<RunState> {
    const run = await this.requireRun(runId)
    const session = await this.requireSession(run.sessionId)
    const updatedSession = {
      ...session,
      activeRunId: run.runId,
      updatedAt: this.deps.now(),
    }
    await this.deps.sessions.put(updatedSession)
    return run
  }

  async ingestCallback(event: KernelCallbackEvent): Promise<void> {
    const run = await this.requireRun(event.runId)
    const session = await this.requireSession(run.sessionId)
    const at = event.receivedAt ?? this.deps.now()

    await this.appendLedgerEvent({
      eventType: 'run.callback_received',
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: run.currentPhase,
      actor: {
        actorType: 'system',
        actorId: 'session-kernel',
      },
      refs: this.getRunRefs(run),
      summary: `Received ${event.type} callback for run ${run.runId}.`,
      payload: event as unknown as Record<string, unknown>,
    })

    let updatedRun: RunState = run
    let eventType = 'run.callback_received'
    let summary = event.summary ?? `Callback processed for run ${run.runId}.`
    let artifactRefs: ArtifactRef[] | undefined

    if (event.type === 'approval_decision') {
      eventType =
        event.status === 'approved' ? 'approval.granted' : 'approval.rejected'
      summary =
        event.summary ??
        `Approval callback marked run ${run.runId} as ${event.status}.`

      const approvalUpdatedRun = await this.approvalPackageHandler.persistApprovalDecisionForRun(
        run,
        event.status,
        event.approvalStateRef,
        event.approvalRecord,
        {
          requirementId: event.requirementId,
          viewedMaterialHash: event.viewedMaterialHash,
          viewedAt: event.viewedAt,
          breakGlassReason: event.breakGlassReason,
        },
        at,
      )

      updatedRun = approvalUpdatedRun.run
      artifactRefs = [approvalUpdatedRun.artifact]

      if (approvalUpdatedRun.approvalState.status === 'approved') {
        eventType =
          event.breakGlassReason != null
            ? 'approval.break_glass_granted'
            : 'approval.granted'
        summary =
          event.summary ??
          (event.breakGlassReason != null
            ? `Break-glass approval granted for state ${approvalUpdatedRun.approvalState.approvalStateId}.`
            : `Approval state ${approvalUpdatedRun.approvalState.approvalStateId} is now approved.`)
        updatedRun = (
          await this.signingBroadcastHandler.beginSigningForRun(session, approvalUpdatedRun.run, at)
        ).run
      } else if (approvalUpdatedRun.approvalState.status === 'pending') {
        eventType = 'approval.recorded'
        summary =
          event.summary ??
          `Approval recorded for state ${approvalUpdatedRun.approvalState.approvalStateId}; more approvals are still required.`
      } else {
        eventType =
          approvalUpdatedRun.approvalState.status === 'rejected'
            ? 'approval.rejected'
            : approvalUpdatedRun.approvalState.status === 'expired'
              ? 'approval.expired'
            : 'approval.invalidated'
        summary =
          event.summary ??
          `Approval state ${approvalUpdatedRun.approvalState.approvalStateId} is now ${approvalUpdatedRun.approvalState.status}.`
        updatedRun = await this.transitionRunPhase(approvalUpdatedRun.run, 'failed', {
          at,
          actor: {
            actorType: 'system',
            actorId: 'session-kernel',
          },
          reason: 'Approval callback rejected, expired, or invalidated the run.',
          status: 'failed',
          context: {},
        })
      }
    }

    if (event.type === 'compliance_status') {
      const complianceUpdate = await this.walletCreateHandler.persistComplianceStatusForRun(
        run,
        session,
        event,
        at,
      )
      updatedRun = complianceUpdate.run
      artifactRefs = complianceUpdate.artifacts
      eventType =
        event.status === 'approved'
          ? 'compliance.approved'
          : event.status === 'rejected'
            ? 'compliance.rejected'
            : event.status === 'restricted'
              ? 'compliance.restricted'
              : 'compliance.pending'
      summary =
        event.summary ??
        `${event.workflowType.toUpperCase()} workflow ${event.complianceWorkflowId} updated to ${event.status} for wallet ${event.walletId}.`

      if (complianceUpdate.previousState !== complianceUpdate.wallet.state) {
        await this.appendLedgerEvent({
          eventType: 'wallet.state_transitioned',
          at,
          runId: run.runId,
          sessionId: run.sessionId,
          phase: updatedRun.currentPhase,
          actor: {
            actorType: 'system',
            actorId: 'session-kernel',
          },
          refs: { ...this.getRunRefs(updatedRun), walletIds: [event.walletId] },
          summary: `Wallet ${event.walletId} state changed from ${complianceUpdate.previousState} to ${complianceUpdate.wallet.state}.`,
          payload: {
            walletId: event.walletId,
            previousState: complianceUpdate.previousState,
            nextState: complianceUpdate.wallet.state,
            complianceStatus: complianceUpdate.wallet.complianceStatus,
          },
          artifactRefs: artifactRefs,
        })
      }
    }

    if (event.type === 'signature_status') {
      eventType = `signature.request_${event.status}`
      summary =
        event.summary ??
        `Signature status for run ${run.runId} is now ${event.status}.`

      const callbackSignatureResult = await this.signingBroadcastHandler.persistSignatureResultForRun(
        updatedRun,
        {
          status: event.status,
          signatureRequestId: event.signatureRequestId,
          signerProfileId: 'callback_signer',
          transactionHash: event.transactionHash,
        },
        at,
      )
      updatedRun = callbackSignatureResult.run
      artifactRefs = [callbackSignatureResult.artifact]

      if (event.status === 'signed') {
        updatedRun = (
          await this.signingBroadcastHandler.continueTransferAfterSignedResult(
            session,
            callbackSignatureResult.run,
            callbackSignatureResult.signatureResult,
            at,
          )
        ).run
      } else if (event.status === 'pending') {
        updatedRun = {
          ...updatedRun,
          status: 'waiting_for_signature',
          currentPhase: 'signing',
          lastUpdatedAt: at,
        }
      } else {
        updatedRun = await this.transitionRunPhase(updatedRun, 'failed', {
          at,
          actor: {
            actorType: 'system',
            actorId: 'session-kernel',
          },
          reason: 'Signature request failed or was rejected.',
          status: 'failed',
          context: {},
        })
      }
    }

    if (event.type === 'broadcast_confirmation') {
      eventType =
        event.status === 'confirmed'
          ? 'broadcast.confirmed'
          : 'broadcast.failed'
      summary =
        event.summary ??
        `Broadcast for run ${run.runId} ${event.status === 'confirmed' ? 'confirmed' : 'failed'}.`

      const callbackBroadcastRun = await this.signingBroadcastHandler.persistBroadcastForRun(
        updatedRun,
        {
          broadcastId: event.broadcastRef,
          runId: updatedRun.runId,
          submittedAt: at,
          status: event.status === 'confirmed' ? 'confirmed' : 'failed',
          transactionHash: event.transactionHash,
          network: 'callback_network',
          signatureRequestId:
            updatedRun.signatureRequestRefs.at(-1) ?? 'unknown_signature_request',
          summary:
            event.status === 'confirmed'
              ? 'Broadcast callback confirmed the transaction.'
              : 'Broadcast callback reported a failed transaction.',
        },
        at,
      )
      updatedRun = callbackBroadcastRun.run
      artifactRefs = [callbackBroadcastRun.artifact]

      if (event.status === 'confirmed') {
        updatedRun = (
          await this.signingBroadcastHandler.continueTransferAfterBroadcast(
            session,
            callbackBroadcastRun.run,
            callbackBroadcastRun.broadcast,
            at,
          )
        ).run
      } else {
        updatedRun = await this.transitionRunPhase(updatedRun, 'failed', {
          at,
          actor: {
            actorType: 'system',
            actorId: 'session-kernel',
          },
          reason: 'Broadcast failed.',
          status: 'failed',
          context: {},
        })
      }
    }

    await this.deps.runs.put(updatedRun)
    await this.syncSessionIndexes(session.sessionId)
    await this.appendLedgerEvent({
      eventType,
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: updatedRun.currentPhase,
      actor: {
        actorType: 'system',
        actorId: 'session-kernel',
      },
      refs: this.getRunRefs(updatedRun),
      summary,
      payload: event as unknown as Record<string, unknown>,
      artifactRefs,
    })
  }

  async haltRun(runId: string, reason: string): Promise<void> {
    const run = await this.requireRun(runId)
    const updatedRun = await this.transitionRunPhase(run, 'halted', {
      at: this.deps.now(),
      actor: {
        actorType: 'system',
        actorId: 'session-kernel',
      },
      reason,
      status: 'halted',
      context: {
        emergencyHaltActive: true,
      },
    })

    await this.syncSessionIndexes(run.sessionId)
    await this.appendLedgerEvent({
      eventType: 'run.halted',
      at: updatedRun.lastUpdatedAt,
      runId,
      sessionId: run.sessionId,
      phase: 'halted',
      actor: {
        actorType: 'system',
        actorId: 'session-kernel',
      },
      refs: this.getRunRefs(updatedRun),
      summary: `Run ${runId} halted.`,
      payload: { reason },
    })
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.deps.persistence.closeSession(sessionId)
    await this.deps.sessions.remove(sessionId)
  }

  private async handleActionRequest(
    session: SessionState,
    input: KernelInput,
    kind: KernelInputKind,
    at: string,
  ): Promise<KernelTurnResult> {
    const actionType =
      input.requestedActionType ?? detectRequestedActionType(input.text) ?? 'unknown'
    const runId = this.deps.createId('run')
    const run: RunState = {
      runId,
      sessionId: session.sessionId,
      actionType,
      status: 'active',
      currentPhase: 'session_setup',
      simulationRefs: [],
      signatureRequestRefs: [],
      signatureResultRefs: [],
      broadcastRefs: [],
      simulationArtifactPaths: [],
      signatureRequestArtifactPaths: [],
      signatureResultArtifactPaths: [],
      broadcastArtifactPaths: [],
      lastUpdatedAt: at,
    }

    await this.deps.runs.put(run)
    await this.appendLedgerEvent({
      eventType: 'run.created',
      at,
      runId,
      sessionId: session.sessionId,
      phase: 'session_setup',
      actor: this.getSessionActor(session),
      refs: this.getRunRefs(run),
      summary: `Run ${runId} created for ${actionType}.`,
      payload: {
        actionType,
        source: input.source,
        inputText: input.text,
      },
    })

    const updatedRun = await this.transitionRunPhase(run, 'intent_capture', {
      at,
      actor: this.getSessionActor(session),
      reason: 'Run created from action request.',
      status: 'active',
      context: {
        activeRunContext: true,
        actorIdentityResolved: true,
      },
    })

    if (actionType === 'asset.transfer') {
      const transferResult = await this.transferHandler.advance(
        session,
        input,
        updatedRun,
        at,
      )

      await this.syncSessionIndexes(session.sessionId, runId)
      const refreshedSession = await this.requireSession(session.sessionId)

      return this.finalizeTurn(
        refreshedSession,
        kind,
        [`Created run ${runId} for ${actionType}.`, ...transferResult.output],
        transferResult.run,
        true,
      )
    }

    if (actionType === 'wallet.create') {
      const walletCreateResult = await this.walletCreateHandler.advance(
        session,
        input,
        updatedRun,
        at,
      )

      await this.syncSessionIndexes(session.sessionId, runId)
      const refreshedSession = await this.requireSession(session.sessionId)

      return this.finalizeTurn(
        refreshedSession,
        kind,
        [`Created run ${runId} for ${actionType}.`, ...walletCreateResult.output],
        walletCreateResult.run,
        true,
      )
    }

    if (actionType === 'treasury.rebalance') {
      const rebalanceResult = await this.treasuryHandler.advance(
        session,
        input,
        updatedRun,
        at,
      )

      await this.syncSessionIndexes(session.sessionId, runId)
      const refreshedSession = await this.requireSession(session.sessionId)

      return this.finalizeTurn(
        refreshedSession,
        kind,
        [`Created run ${runId} for ${actionType}.`, ...rebalanceResult.output],
        rebalanceResult.run,
        true,
      )
    }

    if (actionType === 'treasury.payment_batch') {
      const paymentBatchResult = await this.paymentBatchHandler.advance(
        session,
        input,
        updatedRun,
        at,
      )

      await this.syncSessionIndexes(session.sessionId, runId)
      const refreshedSession = await this.requireSession(session.sessionId)

      return this.finalizeTurn(
        refreshedSession,
        kind,
        [`Created run ${runId} for ${actionType}.`, ...paymentBatchResult.output],
        paymentBatchResult.run,
        true,
      )
    }

    await this.syncSessionIndexes(session.sessionId, runId)
    const refreshedSession = await this.requireSession(session.sessionId)

    return this.finalizeTurn(refreshedSession, kind, [
      `Created run ${runId} for ${actionType}.`,
      'Run is now in intent_capture.',
    ], updatedRun, true)
  }

  private async handleResumeSignal(
    session: SessionState,
    input: KernelInput,
    kind: KernelInputKind,
  ): Promise<KernelTurnResult> {
    if (!input.runId) {
      return this.finalizeTurn(session, kind, [
        'Resume requested without a run id.',
      ])
    }

    let run = await this.resumeRun(input.runId)
    const output = [`Resumed run ${run.runId} at phase ${run.currentPhase}.`]

    if (
      (run.actionType === 'asset.transfer' ||
        run.actionType === 'treasury.rebalance' ||
        run.actionType === 'treasury.payment_batch') &&
      run.currentPhase === 'signing' &&
      run.status === 'waiting_for_signature'
    ) {
      const pollResult = await this.signingBroadcastHandler.pollTransferSignatureStatus(
        session,
        run,
        this.deps.now(),
      )
      run = pollResult.run
      output.push(...pollResult.output)
    }

    if (
      (run.actionType === 'asset.transfer' ||
        run.actionType === 'treasury.rebalance' ||
        run.actionType === 'treasury.payment_batch') &&
      run.currentPhase === 'broadcast' &&
      run.status === 'waiting_for_confirmation'
    ) {
      const pollResult = await this.signingBroadcastHandler.pollTransferBroadcastStatus(
        session,
        run,
        this.deps.now(),
      )
      run = pollResult.run
      output.push(...pollResult.output)
    }

    await this.syncSessionIndexes(session.sessionId, run.runId)
    const refreshedSession = await this.requireSession(session.sessionId)

    return this.finalizeTurn(refreshedSession, kind, output, run)
  }

  private async handleStatusQuery(
    session: SessionState,
    input: KernelInput,
    kind: KernelInputKind,
  ): Promise<KernelTurnResult> {
    const query = input.text ?? 'What is the current session status?'
    const engine = new StatusQueryEngine()
    const result = await engine.answer(query, {
      session,
      runs: this.deps.runs,
      wallets: this.deps.walletRegistry,
      ledger: this.deps.persistence.ledger,
    })
    return this.finalizeTurn(session, kind, result.output)
  }

  private async handleOperatorCommand(
    session: SessionState,
    input: KernelInput,
    kind: KernelInputKind,
  ): Promise<KernelTurnResult> {
    // The command field is set by AIKernelRouter — use it as the primary signal.
    // Fall back to parsing the raw text if not set.
    const command = (input.payload?.['command'] as string | undefined)
      ?? (input.text ?? '')

    const isApprove = /^approve$/i.test(command)
    const isReject = /^reject$/i.test(command)
    const isHalt = /^halt$/i.test(command)
    const isResume = /^resume$/i.test(command)
    const isApprovalPackage =
      /^approval_package$/i.test(command) || /approval package/i.test(command)
    const isPendingCompliance =
      /^pending_compliance$/i.test(command) || /pending compliance/i.test(command)
    const isComplianceStatus = /^compliance_status$/i.test(command)
    const isClose = /^close_session$/i.test(command) || /close session/i.test(command)

    // ── Approval ──────────────────────────────────────────────────────────────
    if (isApprove) {
      // Find the most recent run waiting for approval
      const runId = session.pendingApprovalRunIds.at(-1) ?? session.activeRunId
      if (!runId) {
        return this.finalizeTurn(session, kind, ['No run is waiting for approval.'])
      }
      await this.ingestCallback({
        type: 'approval_decision',
        runId,
        status: 'approved',
        approvalRecord: {
          approver: { actorId: session.actorContext.actorId, role: session.actorContext.roleIds[0] ?? 'operator' },
          decidedAt: this.deps.now(),
          comment: `Approved via operator command: "${input.text ?? 'approve'}"`,
        },
      })
      const updatedRun = await this.deps.runs.get(runId)
      const output = [`Approved run ${runId}.`]
      if (updatedRun?.status === 'completed') output.push('Run completed.')
      else if (updatedRun?.currentPhase === 'signing') output.push('Awaiting signature.')
      return this.finalizeTurn(session, kind, output, updatedRun ?? undefined)
    }

    // ── Rejection ─────────────────────────────────────────────────────────────
    if (isReject) {
      const runId = session.pendingApprovalRunIds.at(-1) ?? session.activeRunId
      if (!runId) {
        return this.finalizeTurn(session, kind, ['No run is waiting for approval.'])
      }
      await this.ingestCallback({
        type: 'approval_decision',
        runId,
        status: 'rejected',
        approvalRecord: {
          approver: { actorId: session.actorContext.actorId, role: session.actorContext.roleIds[0] ?? 'operator' },
          decidedAt: this.deps.now(),
          comment: `Rejected via operator command: "${input.text ?? 'reject'}"`,
        },
      })
      return this.finalizeTurn(session, kind, [`Rejected run ${runId}.`])
    }

    // ── Approval Review Package ───────────────────────────────────────────────
    if (isApprovalPackage) {
      const runId =
        input.runId ?? session.pendingApprovalRunIds.at(-1) ?? session.activeRunId
      if (!runId) {
        return this.finalizeTurn(session, kind, [
          'No run available for approval review package retrieval.',
        ])
      }

      let run = await this.deps.runs.get(runId)
      if (!run) {
        return this.finalizeTurn(session, kind, [`Run ${runId} was not found.`])
      }

      if (!run.approvalReviewArtifactPath) {
        const approvalState = await this.readArtifactJson<ApprovalState>(
          run.approvalArtifactPath,
        )
        if (!approvalState) {
          return this.finalizeTurn(session, kind, [
            `Run ${runId} has no approval state to package.`,
          ], run)
        }
        const review = await this.approvalPackageHandler.writeApprovalReviewPackageArtifact(
          run,
          approvalState,
          this.deps.now(),
        )
        if (review) {
          run = review.run
        }
      }

      const reviewPackage = await this.readArtifactJson<ApprovalReviewPackage>(
        run.approvalReviewArtifactPath,
      )
      if (!reviewPackage || !run.approvalReviewArtifactPath) {
        return this.finalizeTurn(session, kind, [
          `Run ${runId} approval review package is not available.`,
        ], run)
      }

      return this.finalizeTurn(
        session,
        kind,
        [
          `Approval review package ready for run ${runId}.`,
          `Path: ${run.approvalReviewArtifactPath}`,
          `State: ${reviewPackage.status} (${reviewPackage.approvalClass})`,
          `Material hash: ${reviewPackage.materialView.materialHash}`,
        ],
        run,
      )
    }

    if (isPendingCompliance) {
      const orgId = session.orgContext.organizationId
      const allWallets = orgId
        ? await this.deps.walletRegistry.listByOrganization(orgId)
        : await this.deps.walletRegistry.list()
      const pendingWallets = allWallets
        .filter((wallet) => wallet.complianceWorkflowId != null)
        .filter((wallet) => wallet.complianceStatus === 'pending')
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

      if (pendingWallets.length === 0) {
        return this.finalizeTurn(session, kind, ['No wallets are currently pending compliance.'])
      }

      return this.finalizeTurn(session, kind, [
        `Pending compliance workflows: ${pendingWallets.length}.`,
        ...pendingWallets.slice(0, 10).map((wallet) =>
          `${wallet.walletId} (${wallet.walletType ?? 'unknown'}) for ${wallet.subjectId ?? 'unknown subject'} — workflow ${wallet.complianceWorkflowId} — state ${wallet.state}.`,
        ),
      ])
    }

    if (isComplianceStatus) {
      const target =
        (input.payload?.['target'] as string | undefined)
        ?? input.runId
        ?? input.text?.replace(/^\/?compliance\s+/i, '').trim()
      if (!target) {
        return this.finalizeTurn(session, kind, ['Provide a wallet ID or subject ID for compliance status lookup.'])
      }

      const orgId = session.orgContext.organizationId
      const allWallets = orgId
        ? await this.deps.walletRegistry.listByOrganization(orgId)
        : await this.deps.walletRegistry.list()
      const wallet =
        (await this.deps.walletRegistry.get(target)) ??
        allWallets.find((candidate) => candidate.subjectId?.toLowerCase() === target.toLowerCase())

      if (!wallet) {
        return this.finalizeTurn(session, kind, [`No wallet or subject matched "${target}".`])
      }

      return this.finalizeTurn(session, kind, [
        `Wallet ${wallet.walletId} compliance status: ${wallet.complianceStatus}.`,
        `Workflow: ${wallet.complianceWorkflowId ?? 'none'}.`,
        `Wallet state: ${wallet.state}.`,
        `Policy attachment: ${wallet.policyAttachmentStatus}.`,
        `Compliance provider: ${wallet.complianceProviderId ?? 'none'}.`,
        `Provider case: ${wallet.complianceProviderCaseId ?? 'none'}.`,
      ])
    }

    // ── Halt ──────────────────────────────────────────────────────────────────
    if (isHalt) {
      const runId = session.activeRunId
      if (!runId) {
        return this.finalizeTurn(session, kind, ['No active run to halt.'])
      }
      await this.haltRun(runId, `Halted by operator: "${input.text ?? 'halt'}"`)
      return this.finalizeTurn(session, kind, [`Run ${runId} halted.`])
    }

    // ── Resume ────────────────────────────────────────────────────────────────
    if (isResume) {
      const runId = input.runId ?? session.activeRunId
      if (!runId) {
        return this.finalizeTurn(session, kind, ['No run to resume. Provide a run ID.'])
      }
      const run = await this.resumeRun(runId)
      return this.finalizeTurn(session, kind, [`Resumed run ${runId} at phase ${run.currentPhase}.`], run)
    }

    // ── Close session ─────────────────────────────────────────────────────────
    if (isClose) {
      await this.closeSession(session.sessionId)
      return { kind, createdRun: false, session, output: [`Closed session ${session.sessionId}.`] }
    }

    return this.finalizeTurn(session, kind, ['Command acknowledged.'])
  }

  private async finalizeTurn(
    session: SessionState,
    kind: KernelInputKind,
    output: string[],
    run?: RunState,
    createdRun = false,
  ): Promise<KernelTurnResult> {
    const updatedSession: SessionState = {
      ...session,
      updatedAt: this.deps.now(),
    }
    await this.deps.sessions.put(updatedSession)
    await this.deps.persistence.flushCritical(updatedSession.sessionId, run?.runId)

    return {
      kind,
      createdRun,
      session: updatedSession,
      run,
      output,
    }
  }

  private async appendTranscript(entry: TranscriptEntry): Promise<void> {
    await this.deps.persistence.transcript.append(entry)
  }

  private async readArtifactJson<T>(path?: string): Promise<T | undefined> {
    if (!path) {
      return undefined
    }

    const contents = await readFile(path, 'utf8')
    return JSON.parse(contents) as T
  }

  private async transitionRunPhase(
    run: RunState,
    to: RunState['currentPhase'],
    input: {
      at: string
      actor: RuntimeActor
      reason: string
      status?: RunState['status']
      context: PhaseTransitionContext
      payload?: Record<string, unknown>
    },
  ): Promise<RunState> {
    assertPhaseTransition(run.currentPhase, to, input.context)

    const updatedRun: RunState = {
      ...run,
      currentPhase: to,
      status: input.status ?? run.status,
      lastUpdatedAt: input.at,
    }

    await this.deps.runs.put(updatedRun)
    await this.appendLedgerEvent({
      eventType: 'run.phase_transitioned',
      at: input.at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: updatedRun.currentPhase,
      actor: input.actor,
      refs: this.getRunRefs(updatedRun),
      summary: `Run moved from ${run.currentPhase} to ${to}.`,
      payload: {
        from: run.currentPhase,
        to,
        reason: input.reason,
        ...input.payload,
      },
    })

    return updatedRun
  }

  private async appendLedgerEvent(event: {
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
  }): Promise<void> {
    await this.deps.persistence.ledger.append({
      eventId: this.deps.createId('event'),
      eventType: event.eventType,
      at: event.at,
      sessionId: event.sessionId,
      runId: event.runId,
      phase: event.phase,
      actor: event.actor,
      refs: event.refs,
      summary: event.summary,
      payload: event.payload,
      artifactRefs: event.artifactRefs,
    })
  }

  private getRunRefs(run: RunState): LedgerRefs {
    return {
      intentRef: run.intentRef,
      approvalRefs: run.approvalStateRef ? [run.approvalStateRef] : undefined,
      simulationRefs: run.simulationRefs,
      signatureRequestRef: run.signatureRequestRefs.at(-1),
      broadcastRef: run.broadcastRefs.at(-1),
    }
  }

  private getSessionActor(session: SessionState): RuntimeActor {
    return {
      actorType: 'human',
      actorId: session.actorContext.actorId,
    }
  }

  private normalizeSession(session: SessionState): SessionState {
    return {
      ...session,
      runIds: session.runIds ?? [],
      pendingApprovalRunIds: session.pendingApprovalRunIds ?? [],
      pendingSignatureRunIds: session.pendingSignatureRunIds ?? [],
      pendingConfirmationRunIds: session.pendingConfirmationRunIds ?? [],
    }
  }

  private async requireSession(sessionId: string): Promise<SessionState> {
    const session = await this.deps.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`)
    }
    return this.normalizeSession(session)
  }

  private async requireRun(runId: string): Promise<RunState> {
    const run = await this.deps.runs.get(runId)
    if (!run) {
      throw new Error(`Unknown run: ${runId}`)
    }
    return run
  }

  private async syncSessionIndexes(
    sessionId: string,
    activeRunId?: string,
  ): Promise<void> {
    const session = await this.requireSession(sessionId)
    const runs = await this.deps.runs.listBySession(sessionId)
    const updatedSession: SessionState = {
      ...session,
      updatedAt: this.deps.now(),
      activeRunId: activeRunId ?? session.activeRunId,
      runIds: runs.map((run) => run.runId),
      pendingApprovalRunIds: runs
        .filter((run) => run.status === 'waiting_for_approval')
        .map((run) => run.runId),
      pendingSignatureRunIds: runs
        .filter((run) => run.status === 'waiting_for_signature')
        .map((run) => run.runId),
      pendingConfirmationRunIds: runs
        .filter((run) => run.status === 'waiting_for_confirmation')
        .map((run) => run.runId),
    }
    await this.deps.sessions.put(updatedSession)
  }
}

export function inferActionTypeFromText(
  text?: string,
): IntentActionType | undefined {
  return detectRequestedActionType(text)
}
