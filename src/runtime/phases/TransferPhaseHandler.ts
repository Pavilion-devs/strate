import type { SignerClass } from '../../contracts/common.js'
import type { ArtifactRef } from '../../contracts/ledger.js'
import type { PolicyProfile } from '../../contracts/policy.js'
import type { ResolvedPolicyProfile } from '../../contracts/policyResolution.js'
import type { TransferCloseoutReport } from '../../contracts/report.js'
import type { SignerProfile } from '../../contracts/signerProfile.js'
import type { ReconciliationReport } from '../../contracts/reconciliation.js'
import type { SignatureResult } from '../../contracts/signing.js'
import type { BroadcastRecord } from '../../contracts/broadcast.js'
import type {
  ResolvedTransferSourceWallet,
  WalletRecord,
} from '../../contracts/wallet.js'
import type { IntentObject } from '../../contracts/intent.js'
import type {
  KernelInput,
  RunState,
  SessionState,
} from '../../contracts/runtime.js'
import { buildTransferIntent } from '../../transfers/TransferIntentBuilder.js'
import { createTransferMaterialHash } from '../../transfers/materialHash.js'
import { parseTransferRequestWithAI } from '../../transfers/parseTransferRequest.js'
import { validateTransferIntent } from '../../transfers/validateTransferIntent.js'
import type { PhaseHandlerContext } from './PhaseHandlerContext.js'
import type { SigningBroadcastHandler } from './SigningBroadcastHandler.js'
import type { ApprovalPackageHandler } from './ApprovalPackageHandler.js'

export class TransferPhaseHandler {
  private signingBroadcastHandler?: SigningBroadcastHandler
  private approvalPackageHandler?: ApprovalPackageHandler

  constructor(private readonly ctx: PhaseHandlerContext) {}

  setSigningBroadcastHandler(h: SigningBroadcastHandler): void {
    this.signingBroadcastHandler = h
  }

  setApprovalPackageHandler(h: ApprovalPackageHandler): void {
    this.approvalPackageHandler = h
  }

  async advance(
    session: SessionState,
    input: KernelInput,
    run: RunState,
    at: string,
  ): Promise<{ run: RunState; output: string[] }> {
    const parsed = await parseTransferRequestWithAI({
      text: input.text,
      payload: input.payload,
    })

    if (!parsed.ok) {
      const failedRun = await this.ctx.transitionRunPhase(run, 'failed', {
        at,
        actor: this.ctx.getSessionActor(session),
        reason: parsed.error,
        status: 'failed',
        context: {},
        payload: {
          step: 'intent_capture',
          error: parsed.error,
        },
      })

      return {
        run: failedRun,
        output: [parsed.error],
      }
    }

    const normalizedPayload = {
      ...parsed.payload,
      sourceWalletId:
        parsed.payload.sourceWalletId ?? session.orgContext.walletIds?.[0],
    }

    const intentId = this.ctx.createId('intent')
    const intent = buildTransferIntent({
      intentId,
      createdAt: at,
      actor: {
        actorType: 'human',
        actorId: session.actorContext.actorId,
        sessionId: session.sessionId,
      },
      environment: session.environment,
      payload: normalizedPayload,
      organizationId: session.orgContext.organizationId,
      treasuryId: session.orgContext.treasuryIds?.[0],
      walletId: normalizedPayload.sourceWalletId,
      originalRequestText: input.text,
    })
    const materialHash = createTransferMaterialHash(intent)

    const intentArtifact = await this.ctx.persistence.artifacts.write(
      {
        artifactType: 'intent_snapshot',
        path: `runs/${run.runId}/ledger/artifacts/intent/${intent.intentId}-${intent.version}.json`,
      },
      intent,
    )

    let updatedRun: RunState = {
      ...run,
      intentRef: {
        intentId: intent.intentId,
        version: intent.version,
      },
      intentArtifactPath: intentArtifact.path,
      lastUpdatedAt: at,
    }
    await this.ctx.runs.put(updatedRun)
    await this.ctx.appendLedgerEvent({
      eventType: 'intent.created',
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: 'intent_capture',
      actor: this.ctx.getSessionActor(session),
      refs: this.ctx.getRunRefs(updatedRun),
      summary: `Intent ${intent.intentId} created for transfer run ${run.runId}.`,
      payload: {
        actionType: intent.action.type,
        materialHash,
      },
      artifactRefs: [intentArtifact],
    })

    updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'validation', {
      at,
      actor: this.ctx.getSessionActor(session),
      reason: 'Transfer intent persisted and ready for validation.',
      context: {
        intentExists: true,
        intentPersisted: true,
      },
    })

    const validation = validateTransferIntent(intent)
    if (!validation.valid) {
      await this.ctx.appendLedgerEvent({
        eventType: 'intent.rejected',
        at,
        runId: run.runId,
        sessionId: run.sessionId,
        phase: 'validation',
        actor: this.ctx.getSessionActor(session),
        refs: this.ctx.getRunRefs(updatedRun),
        summary: `Transfer intent ${intent.intentId} failed validation.`,
        payload: {
          issues: validation.issues,
          materialHash,
        },
      })

      updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'failed', {
        at,
        actor: this.ctx.getSessionActor(session),
        reason: 'Transfer intent validation failed.',
        status: 'failed',
        context: {},
        payload: {
          issues: validation.issues,
        },
      })

      return {
        run: updatedRun,
        output: [
          `Persisted transfer intent ${intent.intentId}.`,
          `Transfer validation failed: ${validation.issues.join(', ')}.`,
        ],
      }
    }

    await this.ctx.appendLedgerEvent({
      eventType: 'intent.validated',
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: 'validation',
      actor: this.ctx.getSessionActor(session),
      refs: this.ctx.getRunRefs(updatedRun),
      summary: `Transfer intent ${intent.intentId} validated successfully.`,
      payload: {
        materialHash,
      },
    })

    updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'policy_resolution', {
      at,
      actor: this.ctx.getSessionActor(session),
      reason: 'Transfer validation passed.',
      context: {
        validationPassed: true,
      },
    })

    const policyCandidates = await this.ctx.getPolicyCandidates({
      session,
      run: updatedRun,
      kernelInput: input,
    })

    let walletPolicyContext:
      | Awaited<ReturnType<TransferPhaseHandler['resolveTransferWalletContextForPolicy']>>
      | undefined
    if (normalizedPayload.sourceWalletId) {
      try {
        walletPolicyContext = await this.resolveTransferWalletContextForPolicy(
          session,
          normalizedPayload.sourceWalletId,
          normalizedPayload.chainId,
          policyCandidates,
          updatedRun.runId,
          at,
        )

        const walletPolicyArtifact = await this.ctx.persistence.artifacts.write(
          {
            artifactType: 'wallet_resolution',
            path: `runs/${run.runId}/ledger/artifacts/wallet/source_${walletPolicyContext.wallet.walletId}.policy_context.json`,
          },
          {
            providerId: walletPolicyContext.providerId,
            walletId: walletPolicyContext.wallet.walletId,
            walletType: walletPolicyContext.wallet.walletType,
            address: walletPolicyContext.address,
            signerProfileId: walletPolicyContext.signerProfile.signerProfileId,
            signerClass: walletPolicyContext.signerProfile.signerClass,
            state: walletPolicyContext.wallet.state,
            complianceStatus: walletPolicyContext.wallet.complianceStatus,
            signerHealthStatus: walletPolicyContext.wallet.signerHealthStatus,
            trustStatus: walletPolicyContext.wallet.trustStatus,
          },
        )

        await this.ctx.appendLedgerEvent({
          eventType: 'wallet.policy_context_resolved',
          at,
          runId: run.runId,
          sessionId: run.sessionId,
          phase: 'policy_resolution',
          actor: this.ctx.getSessionActor(session),
          refs: this.ctx.getRunRefs(updatedRun),
          summary: `Resolved wallet policy context for ${walletPolicyContext.wallet.walletId}.`,
          payload: {
            walletId: walletPolicyContext.wallet.walletId,
            walletType: walletPolicyContext.wallet.walletType,
            providerId: walletPolicyContext.providerId,
            signerProfileId: walletPolicyContext.signerProfile.signerProfileId,
            signerClass: walletPolicyContext.signerProfile.signerClass,
            state: walletPolicyContext.wallet.state,
          },
          artifactRefs: [walletPolicyArtifact],
        })
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Unknown wallet provider resolution error.'

        await this.ctx.appendLedgerEvent({
          eventType: 'wallet.policy_context_failed',
          at,
          runId: run.runId,
          sessionId: run.sessionId,
          phase: 'policy_resolution',
          actor: this.ctx.getSessionActor(session),
          refs: this.ctx.getRunRefs(updatedRun),
          summary: `Wallet policy context resolution failed for ${normalizedPayload.sourceWalletId}.`,
          payload: {
            walletId: normalizedPayload.sourceWalletId,
            error: message,
          },
        })

        updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'failed', {
          at,
          actor: this.ctx.getSessionActor(session),
          reason: 'Wallet provider resolution failed before policy resolution.',
          status: 'failed',
          context: {},
          payload: {
            walletId: normalizedPayload.sourceWalletId,
            error: message,
          },
        })

        return {
          run: updatedRun,
          output: [
            `Persisted transfer intent ${intent.intentId}.`,
            'Transfer validation passed.',
            `Wallet resolution failed: ${message}.`,
          ],
        }
      }
    }

    const resolvedPolicy = await this.ctx.policyResolver.resolve({
      runId: updatedRun.runId,
      sessionId: updatedRun.sessionId,
      environment: session.environment,
      actor: session.actorContext,
      intentRef: {
        intentId: intent.intentId,
        version: intent.version,
        actionType: intent.action.type,
      },
      walletContext: {
        walletId: walletPolicyContext?.wallet.walletId ?? normalizedPayload.sourceWalletId,
        walletType: walletPolicyContext?.wallet.walletType,
        signerClass: walletPolicyContext?.signerProfile.signerClass,
        signerProfileId: walletPolicyContext?.signerProfile.signerProfileId,
        address: walletPolicyContext?.address,
        providerId: walletPolicyContext?.providerId,
        state: walletPolicyContext?.wallet.state,
        complianceStatus: walletPolicyContext?.wallet.complianceStatus,
        signerHealthStatus: walletPolicyContext?.wallet.signerHealthStatus,
        trustStatus: walletPolicyContext?.wallet.trustStatus,
      },
      treasuryContext: {
        treasuryId: session.orgContext.treasuryIds?.[0],
      },
      emergencyState: {
        haltActive: session.halted,
      },
      policyCandidates,
    })

    const policyArtifact = await this.ctx.persistence.artifacts.write(
      {
        artifactType: 'policy_snapshot',
        path: `runs/${run.runId}/ledger/artifacts/policy/${resolvedPolicy.resolutionId}.json`,
      },
      resolvedPolicy,
    )

    updatedRun = {
      ...updatedRun,
      policyRef: {
        resolutionId: resolvedPolicy.resolutionId,
      },
      policyArtifactPath: policyArtifact.path,
      lastUpdatedAt: at,
    }
    await this.ctx.runs.put(updatedRun)
    await this.ctx.appendLedgerEvent({
      eventType:
        resolvedPolicy.status === 'denied' ? 'policy.denied' : 'policy.resolved',
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: 'policy_resolution',
      actor: this.ctx.getSessionActor(session),
      refs: this.ctx.getRunRefs(updatedRun),
      summary: `Policy resolution completed with status ${resolvedPolicy.status}.`,
      payload: {
        resolutionId: resolvedPolicy.resolutionId,
        status: resolvedPolicy.status,
        reasonCodes: resolvedPolicy.reasonCodes,
        sourceProfileCount: policyCandidates.length,
      },
      artifactRefs: [policyArtifact],
    })

    if (resolvedPolicy.status === 'denied') {
      updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'failed', {
        at,
        actor: this.ctx.getSessionActor(session),
        reason: 'Resolved policy denied the transfer run.',
        status: 'failed',
        context: {},
        payload: {
          resolutionId: resolvedPolicy.resolutionId,
          reasonCodes: resolvedPolicy.reasonCodes,
        },
      })

      return {
        run: updatedRun,
        output: [
          `Persisted transfer intent ${intent.intentId}.`,
          'Transfer validation passed.',
          `Policy denied the run: ${resolvedPolicy.reasonCodes.join(', ') || 'policy.denied'}.`,
        ],
      }
    }

    updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'planning', {
      at,
      actor: this.ctx.getSessionActor(session),
      reason: 'Policy resolution completed and the run is ready for planning.',
      context: {
        resolvedPolicyExists: true,
        actionAllowedToBePlanned: true,
      },
    })

    updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'simulation', {
      at,
      actor: this.ctx.getSessionActor(session),
      reason: 'Transfer plan is ready for deterministic simulation.',
      context: {
        planExists: true,
        planPolicyCompatible: true,
      },
    })

    const simulation = await this.ctx.simulationEngine.simulateTransfer({
      runId: updatedRun.runId,
      sessionId: updatedRun.sessionId,
      intent,
      resolvedPolicy,
      materialHash,
    })

    const simulationArtifact = await this.ctx.persistence.artifacts.write(
      {
        artifactType: 'simulation_record',
        path: `runs/${run.runId}/ledger/artifacts/simulation/${simulation.simulationId}.json`,
      },
      simulation,
    )

    updatedRun = {
      ...updatedRun,
      simulationRefs: [...updatedRun.simulationRefs, simulation.simulationId],
      simulationArtifactPaths: [
        ...updatedRun.simulationArtifactPaths,
        simulationArtifact.path,
      ],
      lastUpdatedAt: at,
    }
    await this.ctx.runs.put(updatedRun)
    await this.ctx.appendLedgerEvent({
      eventType:
        simulation.status === 'succeeded'
          ? 'simulation.completed'
          : 'simulation.failed',
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: 'simulation',
      actor: this.ctx.getSessionActor(session),
      refs: this.ctx.getRunRefs(updatedRun),
      summary: simulation.summary,
      payload: {
        simulationId: simulation.simulationId,
        status: simulation.status,
        resultHash: simulation.resultHash,
        freshnessExpiresAt: simulation.freshnessExpiresAt,
      },
      artifactRefs: [simulationArtifact],
    })

    if (simulation.status !== 'succeeded') {
      updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'failed', {
        at,
        actor: this.ctx.getSessionActor(session),
        reason: 'Transfer simulation failed.',
        status: 'failed',
        context: {},
        payload: {
          simulationId: simulation.simulationId,
        },
      })

      return {
        run: updatedRun,
        output: [
          `Persisted transfer intent ${intent.intentId}.`,
          'Transfer validation passed.',
          `Policy resolved as ${resolvedPolicy.status}.`,
          'Simulation failed.',
        ],
      }
    }

    updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'approval', {
      at,
      actor: this.ctx.getSessionActor(session),
      reason: 'Simulation completed and the run is ready for approval evaluation.',
      context: {
        simulationRequired: resolvedPolicy.signing.requireSimulation,
        simulationCompleted: true,
        simulationFreshnessRecorded: Boolean(
          simulation.freshnessExpiresAt || !resolvedPolicy.signing.requireSimulation,
        ),
      },
    })

    const approvalState = await this.ctx.approvalEngine.evaluateRequirement({
      intentRef: {
        intentId: intent.intentId,
        version: intent.version,
      },
      policy: resolvedPolicy,
      materialHash,
      computedAt: at,
    })

    const approvalArtifact = await this.ctx.persistence.artifacts.write(
      {
        artifactType: 'approval_record',
        path: `runs/${run.runId}/ledger/artifacts/approvals/${approvalState.approvalStateId}.json`,
      },
      approvalState,
    )

    updatedRun = {
      ...updatedRun,
      approvalStateRef: approvalState.approvalStateId,
      approvalArtifactPath: approvalArtifact.path,
      status:
        approvalState.status === 'pending'
          ? 'waiting_for_approval'
          : approvalState.status === 'rejected'
            ? 'failed'
            : 'active',
      lastUpdatedAt: at,
    }
    await this.ctx.runs.put(updatedRun)
    let approvalReviewArtifact: ArtifactRef | undefined
    const approvalReview = await this.approvalPackageHandler!.writeApprovalReviewPackageArtifact(
      updatedRun,
      approvalState,
      at,
    )
    if (approvalReview) {
      updatedRun = approvalReview.run
      approvalReviewArtifact = approvalReview.artifact
    }
    await this.ctx.appendLedgerEvent({
      eventType:
        approvalState.status === 'not_required'
          ? 'approval.not_required'
          : approvalState.status === 'rejected'
            ? 'approval.rejected'
            : 'approval.requested',
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: 'approval',
      actor: this.ctx.getSessionActor(session),
      refs: this.ctx.getRunRefs(updatedRun),
      summary: `Approval state ${approvalState.approvalStateId} computed as ${approvalState.status}.`,
      payload: {
        approvalStateId: approvalState.approvalStateId,
        approvalClass: approvalState.approvalClass,
        status: approvalState.status,
        requiredApprovals: approvalState.requirement.requiredApprovals,
      },
      artifactRefs:
        approvalReviewArtifact != null
          ? [approvalArtifact, approvalReviewArtifact]
          : [approvalArtifact],
    })

    if (approvalState.status === 'rejected') {
      updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'failed', {
        at,
        actor: this.ctx.getSessionActor(session),
        reason: 'Approval evaluation blocked execution.',
        status: 'failed',
        context: {},
        payload: {
          approvalStateId: approvalState.approvalStateId,
        },
      })

      return {
        run: updatedRun,
        output: [
          `Persisted transfer intent ${intent.intentId}.`,
          'Transfer validation passed.',
          `Policy resolved as ${resolvedPolicy.status}.`,
          'Simulation completed.',
          'Approval evaluation blocked the run.',
        ],
      }
    }

    if (approvalState.status === 'not_required') {
      const signingResult = await this.signingBroadcastHandler!.beginSigningForRun(session, updatedRun, at)
      return {
        run: signingResult.run,
        output: [
          `Persisted transfer intent ${intent.intentId}.`,
          'Transfer validation passed.',
          `Policy resolved as ${resolvedPolicy.status}.`,
          'Simulation completed.',
          ...signingResult.output,
        ],
      }
    }

    return {
      run: updatedRun,
      output: [
        `Persisted transfer intent ${intent.intentId}.`,
        'Transfer validation passed.',
        `Policy resolved as ${resolvedPolicy.status}.`,
        'Simulation completed.',
        approvalState.status === 'pending'
          ? 'Approval is now pending.'
          : 'Approval is not required and the run is ready for signing.',
      ],
    }
  }

  private async resolveTransferWalletContext(
    session: SessionState,
    input: {
      sourceWalletId: string
      chainId: string
      runId: string
      at: string
      allowedSignerClasses: SignerClass[]
      requiredSignerClass?: SignerClass
    },
  ): Promise<{
    providerId: string
    address: string
    wallet: ResolvedTransferSourceWallet['wallet']
    resolvedWallet: ResolvedTransferSourceWallet
    signerProfile: SignerProfile
  }> {
    const resolvedWallet = await this.ctx.walletProvider.resolveTransferSource({
      walletId: input.sourceWalletId,
      chainId: input.chainId,
      environment: session.environment,
      actionType: 'asset.transfer',
      requiredSignerClass: input.requiredSignerClass,
      allowedSignerClasses: input.allowedSignerClasses,
    })

    const signerProfile = this.ctx.signerProfiles.resolveCompatible({
      signerProfileId: resolvedWallet.signerProfileId,
      walletId: resolvedWallet.wallet.walletId,
      chainId: input.chainId,
      allowedSignerClasses: input.allowedSignerClasses,
      requiredSignerClass: input.requiredSignerClass,
    })

    return {
      providerId: resolvedWallet.providerId,
      address: resolvedWallet.address,
      wallet: {
        ...resolvedWallet.wallet,
        updatedAt: input.at,
      },
      resolvedWallet: {
        ...resolvedWallet,
        wallet: {
          ...resolvedWallet.wallet,
          updatedAt: input.at,
        },
      },
      signerProfile,
    }
  }

  private async resolveTransferWalletContextForPolicy(
    session: SessionState,
    sourceWalletId: string,
    chainId: string,
    policyCandidates: PolicyProfile[],
    runId: string,
    at: string,
  ): Promise<{
    providerId: string
    address: string
    wallet: ResolvedTransferSourceWallet['wallet']
    resolvedWallet: ResolvedTransferSourceWallet
    signerProfile: SignerProfile
  }> {
    return this.resolveTransferWalletContext(session, {
      sourceWalletId,
      chainId,
      runId,
      at,
      allowedSignerClasses: this.collectTransferSignerClasses(policyCandidates),
    })
  }

  async resolveTransferSigningContext(
    session: SessionState,
    intent: IntentObject,
    resolvedPolicy: ResolvedPolicyProfile,
    runId: string,
    at: string,
  ): Promise<{
    providerId: string
    address: string
    wallet: ResolvedTransferSourceWallet['wallet']
    resolvedWallet: ResolvedTransferSourceWallet
    signerProfile: SignerProfile
  }> {
    if (intent.action.type !== 'asset.transfer') {
      throw new Error(
        `Wallet resolution only supports asset.transfer, received ${intent.action.type}.`,
      )
    }

    const sourceWalletId =
      intent.action.payload.sourceWalletId ?? session.orgContext.walletIds?.[0]
    if (!sourceWalletId) {
      throw new Error(
        `Run ${runId} cannot enter signing without a source wallet id.`,
      )
    }

    const resolvedWalletContext = await this.resolveTransferWalletContext(session, {
      sourceWalletId,
      chainId: intent.action.payload.chainId,
      runId,
      at,
      allowedSignerClasses: resolvedPolicy.signing.allowedSignerClasses,
      requiredSignerClass: resolvedPolicy.signing.requiredSignerClass,
    })

    if (
      resolvedPolicy.scope.allowedWalletIds.length > 0 &&
      !resolvedPolicy.scope.allowedWalletIds.includes(
        resolvedWalletContext.wallet.walletId,
      )
    ) {
      throw new Error(
        `Resolved wallet ${resolvedWalletContext.wallet.walletId} is not allowed by policy for run ${runId}.`,
      )
    }

    return resolvedWalletContext
  }

  collectTransferSignerClasses(
    policyCandidates: PolicyProfile[],
  ): SignerClass[] {
    const signerClasses = new Set<SignerClass>()

    for (const candidate of policyCandidates) {
      for (const signerClass of candidate.permissions.signer.allowedSignerClasses) {
        signerClasses.add(signerClass)
      }

      for (const signerClass of
        candidate.permissions.actions['asset.transfer']?.allowedSignerClasses ?? []) {
        signerClasses.add(signerClass)
      }
    }

    if (signerClasses.size === 0) {
      for (const profile of this.ctx.signerProfiles.list()) {
        signerClasses.add(profile.signerClass)
      }
    }

    return [...signerClasses]
  }

  buildTransferCloseoutReport(input: {
    session: SessionState
    run: RunState
    at: string
    broadcast: BroadcastRecord
    signatureResult: SignatureResult
    reconciliation: ReconciliationReport
  }): TransferCloseoutReport {
    const actionLabel =
      input.run.actionType === 'treasury.rebalance'
        ? 'Treasury rebalance'
        : input.run.actionType === 'treasury.payment_batch'
          ? 'Treasury payment batch'
        : 'Transfer'
    const notes = [
      input.broadcast.summary,
      input.reconciliation.summary,
      ...input.reconciliation.checks
        .filter((check) => check.status === 'failed')
        .map((check) => check.reason ?? check.checkId),
    ]

    return {
      reportId: this.ctx.createId('report'),
      runId: input.run.runId,
      sessionId: input.session.sessionId,
      actionType: input.run.actionType as import('../../contracts/intent.js').IntentActionType,
      createdAt: input.at,
      finalStatus:
        input.reconciliation.status === 'matched' ? 'completed' : 'failed',
      summary:
        input.reconciliation.status === 'matched'
          ? `${actionLabel} run ${input.run.runId} completed successfully.`
          : `${actionLabel} run ${input.run.runId} completed with reconciliation failure.`,
      intentRef: input.run.intentRef,
      approvalStateRef: input.run.approvalStateRef,
      simulationRef: input.run.simulationRefs.at(-1),
      signatureRequestRef: input.run.signatureRequestRefs.at(-1),
      signatureResultRef: input.run.signatureResultRefs.at(-1),
      broadcastRef: input.broadcast.broadcastId,
      reconciliationId: input.reconciliation.reconciliationId,
      reconciliationStatus: input.reconciliation.status,
      transactionHash:
        input.broadcast.transactionHash ?? input.signatureResult.transactionHash,
      notes,
    }
  }
}
