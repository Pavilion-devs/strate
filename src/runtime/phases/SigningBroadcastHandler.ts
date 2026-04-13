import type { ApprovalState } from '../../contracts/approval.js'
import type { BroadcastRecord } from '../../contracts/broadcast.js'
import type { ArtifactRef } from '../../contracts/ledger.js'
import type { ResolvedPolicyProfile } from '../../contracts/policyResolution.js'
import type { SimulationRecord } from '../../contracts/simulation.js'
import type {
  SignatureRequest,
  SignatureResult,
} from '../../contracts/signing.js'
import type { IntentObject } from '../../contracts/intent.js'
import type {
  RunState,
  SessionState,
} from '../../contracts/runtime.js'
import { buildTransferSignatureRequest } from '../../signing/buildTransferSignatureRequest.js'
import { buildPaymentBatchSignatureRequest } from '../../signing/buildPaymentBatchSignatureRequest.js'
import { createTransferMaterialHash } from '../../transfers/materialHash.js'
import { createPaymentBatchMaterialHash } from '../../treasury/paymentBatchMaterialHash.js'
import type { PhaseHandlerContext } from './PhaseHandlerContext.js'
import type { TransferPhaseHandler } from './TransferPhaseHandler.js'
import type { PaymentBatchPhaseHandler } from './PaymentBatchPhaseHandler.js'
import type { ApprovalPackageHandler } from './ApprovalPackageHandler.js'
import { appendUnique, isTimestampExpired } from './phaseUtils.js'

export class SigningBroadcastHandler {
  private transferHandler?: TransferPhaseHandler
  private paymentBatchHandler?: PaymentBatchPhaseHandler
  private approvalPackageHandler?: ApprovalPackageHandler

  constructor(private readonly ctx: PhaseHandlerContext) {}

  setTransferHandler(h: TransferPhaseHandler): void {
    this.transferHandler = h
  }

  setPaymentBatchHandler(h: PaymentBatchPhaseHandler): void {
    this.paymentBatchHandler = h
  }

  setApprovalPackageHandler(h: ApprovalPackageHandler): void {
    this.approvalPackageHandler = h
  }

  async beginSigningForRun(
    session: SessionState,
    run: RunState,
    at: string,
  ): Promise<{ run: RunState; output: string[] }> {
    const rawIntent = await this.ctx.readArtifactJson<IntentObject>(run.intentArtifactPath)
    const resolvedPolicy = await this.ctx.readArtifactJson<ResolvedPolicyProfile>(
      run.policyArtifactPath,
    )
    const simulation = await this.ctx.readArtifactJson<SimulationRecord>(
      run.simulationArtifactPaths.at(-1),
    )
    const approvalState = await this.ctx.readArtifactJson<ApprovalState>(
      run.approvalArtifactPath,
    )

    if (!rawIntent || !resolvedPolicy || !simulation) {
      throw new Error('Signing requires intent, policy, and simulation artifacts.')
    }

    const intent =
      rawIntent.action.type === 'treasury.payment_batch'
        ? rawIntent
        : await this.toTransferSigningIntent(session, rawIntent, simulation)
    const materialHash =
      intent.action.type === 'treasury.payment_batch'
        ? createPaymentBatchMaterialHash(intent)
        : createTransferMaterialHash(intent)
    const simulationIsStale =
      resolvedPolicy.signing.requireSimulation &&
      isTimestampExpired(simulation.freshnessExpiresAt, at)

    if (
      approvalState?.status === 'approved' &&
      approvalState.requirement.materialHash !== materialHash
    ) {
      const invalidatedApproval = await this.approvalPackageHandler!.persistApprovalDecisionForRun(
        run,
        'invalidated',
        approvalState.approvalStateId,
        undefined,
        undefined,
        at,
      )
      await this.ctx.appendLedgerEvent({
        eventType: 'approval.invalidated',
        at,
        runId: run.runId,
        sessionId: run.sessionId,
        phase: invalidatedApproval.run.currentPhase,
        actor: this.ctx.getSessionActor(session),
        refs: this.ctx.getRunRefs(invalidatedApproval.run),
        summary: `Approval ${approvalState.approvalStateId} invalidated due to material hash drift.`,
        payload: {
          approvalStateId: approvalState.approvalStateId,
          expectedMaterialHash: approvalState.requirement.materialHash,
          currentMaterialHash: materialHash,
        },
        artifactRefs: [invalidatedApproval.artifact],
      })

      const failedRun = await this.ctx.transitionRunPhase(
        invalidatedApproval.run,
        'failed',
        {
          at,
          actor: this.ctx.getSessionActor(session),
          reason:
            'Approval material hash does not match the current signing material.',
          status: 'failed',
          context: {},
          payload: {
            approvalStateId: approvalState.approvalStateId,
          },
        },
      )

      return {
        run: failedRun,
        output: [
          'Approval became invalid because execution material changed.',
          'Re-run simulation and request approval again.',
        ],
      }
    }

    const approvalExpiry =
      approvalState?.expiresAt ?? approvalState?.requirement.expiresAt
    if (
      approvalState?.status === 'approved' &&
      isTimestampExpired(approvalExpiry, at)
    ) {
      const expiredApproval = await this.approvalPackageHandler!.persistApprovalDecisionForRun(
        run,
        'expired',
        approvalState.approvalStateId,
        undefined,
        undefined,
        at,
      )
      await this.ctx.appendLedgerEvent({
        eventType: 'approval.expired',
        at,
        runId: run.runId,
        sessionId: run.sessionId,
        phase: expiredApproval.run.currentPhase,
        actor: this.ctx.getSessionActor(session),
        refs: this.ctx.getRunRefs(expiredApproval.run),
        summary: `Approval ${approvalState.approvalStateId} expired before signing.`,
        payload: {
          approvalStateId: approvalState.approvalStateId,
          expiresAt: approvalExpiry,
        },
        artifactRefs: [expiredApproval.artifact],
      })

      const failedRun = await this.ctx.transitionRunPhase(expiredApproval.run, 'failed', {
        at,
        actor: this.ctx.getSessionActor(session),
        reason: 'Approval expired before signing could begin.',
        status: 'failed',
        context: {},
        payload: {
          approvalStateId: approvalState.approvalStateId,
        },
      })

      return {
        run: failedRun,
        output: [
          'Approval expired before signing started.',
          'Request a fresh approval to continue.',
        ],
      }
    }

    if (simulationIsStale) {
      if (approvalState?.status === 'approved') {
        const invalidatedApproval = await this.approvalPackageHandler!.persistApprovalDecisionForRun(
          run,
          'invalidated',
          approvalState.approvalStateId,
          undefined,
          undefined,
          at,
        )
        await this.ctx.appendLedgerEvent({
          eventType: 'approval.invalidated',
          at,
          runId: run.runId,
          sessionId: run.sessionId,
          phase: invalidatedApproval.run.currentPhase,
          actor: this.ctx.getSessionActor(session),
          refs: this.ctx.getRunRefs(invalidatedApproval.run),
          summary: `Approval ${approvalState.approvalStateId} invalidated because simulation freshness expired.`,
          payload: {
            approvalStateId: approvalState.approvalStateId,
            simulationId: simulation.simulationId,
            freshnessExpiresAt: simulation.freshnessExpiresAt,
          },
          artifactRefs: [invalidatedApproval.artifact],
        })

        const failedRun = await this.ctx.transitionRunPhase(
          invalidatedApproval.run,
          'failed',
          {
            at,
            actor: this.ctx.getSessionActor(session),
            reason:
              'Simulation freshness expired before signing; approval was invalidated.',
            status: 'failed',
            context: {},
            payload: {
              approvalStateId: approvalState.approvalStateId,
              simulationId: simulation.simulationId,
            },
          },
        )

        return {
          run: failedRun,
          output: [
            'Simulation freshness expired before signing.',
            'Approval was invalidated; re-run simulation and request approval again.',
          ],
        }
      }

      await this.ctx.appendLedgerEvent({
        eventType: 'simulation.stale',
        at,
        runId: run.runId,
        sessionId: run.sessionId,
        phase: run.currentPhase,
        actor: this.ctx.getSessionActor(session),
        refs: this.ctx.getRunRefs(run),
        summary: `Simulation ${simulation.simulationId} expired before signing.`,
        payload: {
          simulationId: simulation.simulationId,
          freshnessExpiresAt: simulation.freshnessExpiresAt,
        },
      })

      const failedRun = await this.ctx.transitionRunPhase(run, 'failed', {
        at,
        actor: this.ctx.getSessionActor(session),
        reason: 'Simulation freshness expired before signing.',
        status: 'failed',
        context: {},
        payload: {
          simulationId: simulation.simulationId,
          freshnessExpiresAt: simulation.freshnessExpiresAt,
        },
      })

      return {
        run: failedRun,
        output: [
          'Simulation freshness expired before signing.',
          'Re-run the action to produce a fresh simulation.',
        ],
      }
    }

    const walletResolution =
      rawIntent.action.type === 'treasury.payment_batch'
        ? await this.paymentBatchHandler!.resolvePaymentBatchSigningContext(
            session,
            rawIntent,
            resolvedPolicy,
            run.runId,
            at,
          )
        : await this.transferHandler!.resolveTransferSigningContext(
            session,
            intent,
            resolvedPolicy,
            run.runId,
            at,
          )
    const walletResolutionArtifact = await this.ctx.persistence.artifacts.write(
      {
        artifactType: 'wallet_resolution',
        path: `runs/${run.runId}/ledger/artifacts/wallet/source_${walletResolution.wallet.walletId}.signing_resolution.json`,
      },
      {
        providerId: walletResolution.providerId,
        walletId: walletResolution.wallet.walletId,
        address: walletResolution.address,
        signerProfileId: walletResolution.signerProfile.signerProfileId,
        signerClass: walletResolution.signerProfile.signerClass,
        supportedChains: walletResolution.resolvedWallet.supportedChains,
      },
    )
    await this.ctx.appendLedgerEvent({
      eventType: 'wallet.source_resolved',
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: run.currentPhase,
      actor: this.ctx.getSessionActor(session),
      refs: this.ctx.getRunRefs(run),
      summary: `Resolved source wallet ${walletResolution.wallet.walletId} to ${walletResolution.address} using signer profile ${walletResolution.signerProfile.signerProfileId}.`,
      payload: {
        walletId: walletResolution.wallet.walletId,
        providerId: walletResolution.providerId,
        address: walletResolution.address,
        signerProfileId: walletResolution.signerProfile.signerProfileId,
        signerClass: walletResolution.signerProfile.signerClass,
      },
      artifactRefs: [walletResolutionArtifact],
    })

    const updatedRun = await this.ctx.transitionRunPhase(run, 'signing', {
      at,
      actor: this.ctx.getSessionActor(session),
      reason: 'Signing prerequisites satisfied.',
      status: 'waiting_for_signature',
      context: {
        approvalStatus: approvalState?.status ?? 'not_required',
        approvalInvalidated: approvalState?.status === 'invalidated',
        emergencyHaltActive: session.halted,
      },
    })

    const signatureRequestId = this.ctx.createId('signature_request')
    const signatureRequest =
      intent.action.type === 'treasury.payment_batch'
        ? buildPaymentBatchSignatureRequest({
            signatureRequestId,
            createdAt: at,
            intent,
            resolvedPolicy,
            simulation,
            approvalState,
            sourceAddress: walletResolution.address,
            signerProfile: walletResolution.signerProfile,
          })
        : buildTransferSignatureRequest({
            signatureRequestId,
            createdAt: at,
            intent,
            resolvedPolicy,
            simulation,
            approvalState,
            sourceAddress: walletResolution.address,
            signerProfile: walletResolution.signerProfile,
          })

    const signatureRequestArtifact = await this.ctx.persistence.artifacts.write(
      {
        artifactType: 'signature_request',
        path: `runs/${run.runId}/ledger/artifacts/signatures/${signatureRequestId}.request.json`,
      },
      signatureRequest,
    )

    let signingRun: RunState = {
      ...updatedRun,
      signatureRequestRefs: [
        ...updatedRun.signatureRequestRefs,
        signatureRequest.signatureRequestId,
      ],
      signatureRequestArtifactPaths: [
        ...updatedRun.signatureRequestArtifactPaths,
        signatureRequestArtifact.path,
      ],
      lastUpdatedAt: at,
    }
    await this.ctx.runs.put(signingRun)
    await this.ctx.appendLedgerEvent({
      eventType: 'signature.request_created',
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: 'signing',
      actor: this.ctx.getSessionActor(session),
      refs: this.ctx.getRunRefs(signingRun),
      summary: `Signature request ${signatureRequest.signatureRequestId} created.`,
      payload: {
        signerProfileId: signatureRequest.signer.signerProfileId,
        signerClass: signatureRequest.signer.signerClass,
        simulationId: simulation.simulationId,
        materialHash,
      },
      artifactRefs: [signatureRequestArtifact],
    })

    const signatureResult = await this.ctx.signerGateway.requestSignature(
      signatureRequest,
    )
    const signatureResultArtifact = await this.ctx.persistence.artifacts.write(
      {
        artifactType: 'signature_result',
        path: `runs/${run.runId}/ledger/artifacts/signatures/${signatureRequestId}.result.json`,
      },
      signatureResult,
    )

    signingRun = {
      ...signingRun,
      signatureResultRefs: [
        ...signingRun.signatureResultRefs,
        signatureResult.signatureRequestId,
      ],
      signatureResultArtifactPaths: [
        ...signingRun.signatureResultArtifactPaths,
        signatureResultArtifact.path,
      ],
      status:
        signatureResult.status === 'pending'
          ? 'waiting_for_signature'
          : signatureResult.status === 'signed'
            ? 'active'
            : 'failed',
      lastUpdatedAt: at,
    }
    await this.ctx.runs.put(signingRun)
    await this.ctx.appendLedgerEvent({
      eventType: `signature.request_${signatureResult.status}`,
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: 'signing',
      actor: this.ctx.getSessionActor(session),
      refs: this.ctx.getRunRefs(signingRun),
      summary: `Signature request ${signatureRequest.signatureRequestId} returned ${signatureResult.status}.`,
      payload: {
        signerProfileId: signatureResult.signerProfileId,
        transactionHash: signatureResult.transactionHash,
        errorMessage: signatureResult.errorMessage,
      },
      artifactRefs: [signatureResultArtifact],
    })

    if (signatureResult.status === 'signed') {
      const broadcastResult = await this.continueTransferAfterSignedResult(
        session,
        signingRun,
        signatureResult,
        at,
      )

      return {
        run: broadcastResult.run,
        output: [
          `Signature request ${signatureRequest.signatureRequestId} created.`,
          'Signature request returned signed.',
          ...broadcastResult.output,
        ],
      }
    }

    if (signatureResult.status !== 'pending') {
      const failedRun = await this.ctx.transitionRunPhase(signingRun, 'failed', {
        at,
        actor: this.ctx.getSessionActor(session),
        reason: 'Signing backend did not return a usable signature result.',
        status: 'failed',
        context: {},
        payload: {
          signatureRequestId: signatureRequest.signatureRequestId,
          status: signatureResult.status,
        },
      })

      return {
        run: failedRun,
        output: [
          `Signature request ${signatureRequest.signatureRequestId} created.`,
          `Signature request returned ${signatureResult.status}.`,
        ],
      }
    }

    return {
      run: signingRun,
      output: [
        `Signature request ${signatureRequest.signatureRequestId} created.`,
        signatureResult.status === 'pending'
          ? 'Signature request submitted and is now pending.'
          : `Signature request returned ${signatureResult.status}.`,
      ],
    }
  }

  private async toTransferSigningIntent(
    session: SessionState,
    intent: IntentObject,
    simulation: SimulationRecord,
  ): Promise<IntentObject> {
    if (intent.action.type === 'asset.transfer') {
      return intent
    }

    if (intent.action.type !== 'treasury.rebalance') {
      throw new Error(
        `Signing currently supports asset.transfer and treasury.rebalance, received ${intent.action.type}.`,
      )
    }

    const payload = intent.action.payload
    const sourceWalletId =
      payload.sourceWalletId ??
      session.orgContext.walletIds?.[0] ??
      `wallet_treasury_${payload.treasuryId}`

    let destinationAddress: string | undefined
    if (payload.destinationWalletId) {
      const destinationWallet = await this.ctx.walletRegistry.get(
        payload.destinationWalletId,
      )
      destinationAddress = destinationWallet?.address
    }

    if (!destinationAddress) {
      const creditDelta = simulation.expectedAssetDeltas.find(
        (delta) =>
          delta.direction === 'credit' &&
          delta.assetSymbol.toUpperCase() === payload.assetSymbol.toUpperCase(),
      )
      if (
        creditDelta?.address &&
        !creditDelta.address.startsWith('treasury_destination_')
      ) {
        destinationAddress = creditDelta.address
      }
    }

    if (!destinationAddress) {
      throw new Error(
        'Treasury rebalance signing requires a destination wallet with a resolved address.',
      )
    }

    const creditedAmount =
      simulation.expectedAssetDeltas.find(
        (delta) =>
          delta.direction === 'credit' &&
          delta.assetSymbol.toUpperCase() === payload.assetSymbol.toUpperCase(),
      )?.amount ?? payload.targetAmount

    return {
      ...intent,
      action: {
        type: 'asset.transfer',
        payload: {
          sourceWalletId,
          destinationAddress,
          chainId: payload.chainId,
          assetSymbol: payload.assetSymbol,
          amount: creditedAmount,
          note: `treasury_rebalance:${payload.objective}`,
        },
      },
      scope: {
        ...intent.scope,
        walletId: sourceWalletId,
        chainIds: [payload.chainId],
        assetSymbols: [payload.assetSymbol],
      },
      explanation: {
        ...intent.explanation,
        effectStatement:
          intent.explanation.effectStatement ??
          `Rebalance ${creditedAmount} ${payload.assetSymbol} within treasury ${payload.treasuryId}.`,
      },
    }
  }

  async persistSignatureResultForRun(
    run: RunState,
    signatureResult: SignatureResult,
    at: string,
    artifactLabel = `callback_${this.ctx.createId('signature_status')}`,
  ): Promise<{
    run: RunState
    signatureResult: SignatureResult
    artifact: ArtifactRef
  }> {
    const artifact = await this.ctx.persistence.artifacts.write(
      {
        artifactType: 'signature_result',
        path: `runs/${run.runId}/ledger/artifacts/signatures/${signatureResult.signatureRequestId}.${artifactLabel}.${signatureResult.status}.json`,
      },
      signatureResult,
    )

    const updatedRun: RunState = {
      ...run,
      signatureRequestRefs: appendUnique(
        run.signatureRequestRefs,
        signatureResult.signatureRequestId,
      ),
      signatureResultRefs: appendUnique(
        run.signatureResultRefs,
        signatureResult.signatureRequestId,
      ),
      signatureResultArtifactPaths: appendUnique(
        run.signatureResultArtifactPaths,
        artifact.path,
      ),
      status:
        signatureResult.status === 'pending'
          ? 'waiting_for_signature'
          : signatureResult.status === 'signed'
            ? 'active'
            : 'failed',
      lastUpdatedAt: at,
    }

    await this.ctx.runs.put(updatedRun)

    return {
      run: updatedRun,
      signatureResult,
      artifact,
    }
  }

  async pollTransferSignatureStatus(
    session: SessionState,
    run: RunState,
    at: string,
  ): Promise<{ run: RunState; output: string[] }> {
    const signatureRequestId = run.signatureRequestRefs.at(-1)
    if (!signatureRequestId) {
      throw new Error('Signature polling requires a persisted signature request ref.')
    }

    const signatureResult = await this.ctx.signerGateway.getSignatureResult(
      signatureRequestId,
    )
    const persistedSignature = await this.persistSignatureResultForRun(
      run,
      signatureResult,
      at,
      `poll_${this.ctx.createId('signature_status')}`,
    )

    await this.ctx.appendLedgerEvent({
      eventType: 'signature.status_polled',
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: 'signing',
      actor: {
        actorType: 'system',
        actorId: 'session-kernel',
      },
      refs: this.ctx.getRunRefs(persistedSignature.run),
      summary: `Polled signature request ${signatureRequestId}; current status is ${signatureResult.status}.`,
      payload: {
        signatureRequestId,
        status: signatureResult.status,
        signerProfileId: signatureResult.signerProfileId,
        transactionHash: signatureResult.transactionHash,
      },
      artifactRefs: [persistedSignature.artifact],
    })

    if (signatureResult.status === 'signed') {
      return this.continueTransferAfterSignedResult(
        session,
        persistedSignature.run,
        persistedSignature.signatureResult,
        at,
      )
    }

    if (signatureResult.status === 'pending') {
      return {
        run: persistedSignature.run,
        output: [`Signature request ${signatureRequestId} is still pending.`],
      }
    }

    const failedRun = await this.ctx.transitionRunPhase(persistedSignature.run, 'failed', {
      at,
      actor: this.ctx.getSessionActor(session),
      reason: 'Signature polling returned a terminal non-signed result.',
      status: 'failed',
      context: {},
      payload: {
        signatureRequestId,
        status: signatureResult.status,
      },
    })

    return {
      run: failedRun,
      output: [
        `Signature request ${signatureRequestId} returned ${signatureResult.status}.`,
      ],
    }
  }

  async persistBroadcastForRun(
    run: RunState,
    broadcast: BroadcastRecord,
    at: string,
  ): Promise<{
    run: RunState
    broadcast: BroadcastRecord
    artifact: ArtifactRef
  }> {
    const artifact = await this.ctx.persistence.artifacts.write(
      {
        artifactType: 'broadcast_record',
        path: `runs/${run.runId}/ledger/artifacts/broadcast/${broadcast.broadcastId}.${broadcast.status}.json`,
      },
      broadcast,
    )

    const updatedRun: RunState = {
      ...run,
      broadcastRefs: appendUnique(run.broadcastRefs, broadcast.broadcastId),
      broadcastArtifactPaths: appendUnique(
        run.broadcastArtifactPaths,
        artifact.path,
      ),
      status:
        broadcast.status === 'confirmed'
          ? 'active'
          : broadcast.status === 'submitted'
            ? 'waiting_for_confirmation'
            : 'failed',
      lastUpdatedAt: at,
    }

    await this.ctx.runs.put(updatedRun)

    return {
      run: updatedRun,
      broadcast,
      artifact,
    }
  }

  async pollTransferBroadcastStatus(
    session: SessionState,
    run: RunState,
    at: string,
  ): Promise<{ run: RunState; output: string[] }> {
    const broadcastPath = this.findLatestPathContaining(
      run.broadcastArtifactPaths,
      run.broadcastRefs.at(-1),
    )
    const currentBroadcast = await this.ctx.readArtifactJson<BroadcastRecord>(
      broadcastPath,
    )

    if (!currentBroadcast) {
      throw new Error('Broadcast polling requires a persisted broadcast artifact.')
    }

    const refreshedBroadcast = await this.ctx.broadcaster.refreshBroadcast({
      runId: run.runId,
      sessionId: run.sessionId,
      record: currentBroadcast,
    })

    if (refreshedBroadcast.status === 'submitted') {
      const waitingRun: RunState = {
        ...run,
        status: 'waiting_for_confirmation',
        lastUpdatedAt: at,
      }
      await this.ctx.runs.put(waitingRun)
      await this.ctx.appendLedgerEvent({
        eventType: 'broadcast.confirmation_pending',
        at,
        runId: run.runId,
        sessionId: run.sessionId,
        phase: 'broadcast',
        actor: {
          actorType: 'system',
          actorId: 'session-kernel',
        },
        refs: this.ctx.getRunRefs(waitingRun),
        summary: `Broadcast ${currentBroadcast.broadcastId} is still awaiting confirmation.`,
        payload: {
          broadcastId: currentBroadcast.broadcastId,
          status: refreshedBroadcast.status,
          transactionHash: refreshedBroadcast.transactionHash,
        },
      })

      return {
        run: waitingRun,
        output: [
          `Broadcast ${currentBroadcast.broadcastId} is still awaiting confirmation.`,
        ],
      }
    }

    const persistedBroadcast = await this.persistBroadcastForRun(
      run,
      refreshedBroadcast,
      at,
    )
    await this.ctx.appendLedgerEvent({
      eventType:
        refreshedBroadcast.status === 'confirmed'
          ? 'broadcast.confirmed'
          : 'broadcast.failed',
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: 'broadcast',
      actor: {
        actorType: 'system',
        actorId: 'session-kernel',
      },
      refs: this.ctx.getRunRefs(persistedBroadcast.run),
      summary: refreshedBroadcast.summary,
      payload: {
        broadcastId: refreshedBroadcast.broadcastId,
        status: refreshedBroadcast.status,
        transactionHash: refreshedBroadcast.transactionHash,
        network: refreshedBroadcast.network,
      },
      artifactRefs: [persistedBroadcast.artifact],
    })

    if (refreshedBroadcast.status === 'confirmed') {
      return this.continueTransferAfterBroadcast(
        session,
        persistedBroadcast.run,
        persistedBroadcast.broadcast,
        at,
      )
    }

    const failedRun = await this.ctx.transitionRunPhase(
      persistedBroadcast.run,
      'failed',
      {
        at,
        actor: this.ctx.getSessionActor(session),
        reason: 'Broadcast failed during confirmation polling.',
        status: 'failed',
        context: {},
        payload: {
          broadcastId: refreshedBroadcast.broadcastId,
        },
      },
    )

    return {
      run: failedRun,
      output: [`Broadcast ${refreshedBroadcast.broadcastId} failed.`],
    }
  }

  async continueTransferAfterSignedResult(
    session: SessionState,
    run: RunState,
    signatureResult: SignatureResult,
    at: string,
  ): Promise<{ run: RunState; output: string[] }> {
    const resolvedPolicy = await this.ctx.readArtifactJson<ResolvedPolicyProfile>(
      run.policyArtifactPath,
    )
    const signatureRequestPath = this.findLatestPathContaining(
      run.signatureRequestArtifactPaths,
      signatureResult.signatureRequestId,
    )
    const signatureRequest = await this.ctx.readArtifactJson<SignatureRequest>(
      signatureRequestPath,
    )

    if (!resolvedPolicy || !signatureRequest) {
      throw new Error(
        'Broadcast requires a resolved policy and a signature request artifact.',
      )
    }

    if (!resolvedPolicy.signing.broadcastAllowed) {
      const failedRun = await this.ctx.transitionRunPhase(run, 'failed', {
        at,
        actor: this.ctx.getSessionActor(session),
        reason: 'Resolved policy does not allow broadcasting signed payloads.',
        status: 'failed',
        context: {},
        payload: {
          signatureRequestId: signatureResult.signatureRequestId,
          resolutionId: resolvedPolicy.resolutionId,
        },
      })

      return {
        run: failedRun,
        output: ['Signed payload received, but policy blocked broadcast.'],
      }
    }

    const broadcastRun = await this.ctx.transitionRunPhase(run, 'broadcast', {
      at,
      actor: this.ctx.getSessionActor(session),
      reason: 'Signed payload is ready for broadcast.',
      status: 'active',
      context: {
        signatureResultExists: true,
        signatureValidForPlannedPayload:
          signatureResult.status === 'signed' &&
          signatureRequest.signatureRequestId ===
            signatureResult.signatureRequestId,
      },
    })

    const broadcast = await this.ctx.broadcaster.broadcastSignedTransfer({
      runId: run.runId,
      sessionId: run.sessionId,
      signatureRequest,
      signatureResult,
    })
    const persistedBroadcast = await this.persistBroadcastForRun(
      broadcastRun,
      broadcast,
      at,
    )

    await this.ctx.appendLedgerEvent({
      eventType:
        broadcast.status === 'confirmed'
          ? 'broadcast.confirmed'
          : 'broadcast.submitted',
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: 'broadcast',
      actor: this.ctx.getSessionActor(session),
      refs: this.ctx.getRunRefs(persistedBroadcast.run),
      summary: broadcast.summary,
      payload: {
        broadcastId: broadcast.broadcastId,
        status: broadcast.status,
        transactionHash: broadcast.transactionHash,
        network: broadcast.network,
        signatureRequestId: broadcast.signatureRequestId,
      },
      artifactRefs: [persistedBroadcast.artifact],
    })

    if (broadcast.status === 'confirmed') {
      return this.continueTransferAfterBroadcast(
        session,
        persistedBroadcast.run,
        persistedBroadcast.broadcast,
        at,
      )
    }

    return {
      run: persistedBroadcast.run,
      output: [
        `Broadcast ${broadcast.broadcastId} submitted and is awaiting confirmation.`,
      ],
    }
  }

  async continueTransferAfterBroadcast(
    session: SessionState,
    run: RunState,
    broadcast: BroadcastRecord,
    at: string,
  ): Promise<{ run: RunState; output: string[] }> {
    const rawIntent = await this.ctx.readArtifactJson<IntentObject>(
      run.intentArtifactPath,
    )
    const simulation = await this.ctx.readArtifactJson<SimulationRecord>(
      run.simulationArtifactPaths.at(-1),
    )
    const signatureResultPath = this.findLatestPathContaining(
      run.signatureResultArtifactPaths,
      broadcast.signatureRequestId,
    )
    const signatureResult = await this.ctx.readArtifactJson<SignatureResult>(
      signatureResultPath,
    )

    if (!rawIntent || !simulation || !signatureResult) {
      throw new Error(
        'Reconciliation requires intent, simulation, and signature result artifacts.',
      )
    }

    const intent =
      rawIntent.action.type === 'treasury.payment_batch'
        ? rawIntent
        : await this.toTransferSigningIntent(session, rawIntent, simulation)

    const reconciliationRun = await this.ctx.transitionRunPhase(
      run,
      'reconciliation',
      {
        at,
        actor: this.ctx.getSessionActor(session),
        reason: 'Broadcast completed and reconciliation can now run.',
        status: 'active',
        context: {
          broadcastHandleExists: Boolean(
            broadcast.transactionHash || broadcast.broadcastId,
          ),
        },
      },
    )

    const reconciliation = await this.ctx.reconciler.reconcileTransfer({
      runId: run.runId,
      intent,
      simulation,
      signatureResult,
      broadcast,
    })
    const reconciliationArtifact = await this.ctx.persistence.artifacts.write(
      {
        artifactType: 'reconciliation_report',
        path: `runs/${run.runId}/ledger/artifacts/reconciliation/${reconciliation.reconciliationId}.json`,
      },
      reconciliation,
    )

    let updatedRun: RunState = {
      ...reconciliationRun,
      reconciliationArtifactPath: reconciliationArtifact.path,
      lastUpdatedAt: at,
    }
    await this.ctx.runs.put(updatedRun)
    await this.ctx.appendLedgerEvent({
      eventType:
        reconciliation.status === 'matched'
          ? 'reconciliation.matched'
          : reconciliation.status === 'mismatch'
            ? 'reconciliation.mismatch'
            : 'reconciliation.failed',
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: 'reconciliation',
      actor: this.ctx.getSessionActor(session),
      refs: this.ctx.getRunRefs(updatedRun),
      summary: reconciliation.summary,
      payload: {
        reconciliationId: reconciliation.reconciliationId,
        status: reconciliation.status,
        observedTransactionHash: reconciliation.observedTransactionHash,
        failedChecks: reconciliation.checks
          .filter((check) => check.status === 'failed')
          .map((check) => check.checkId),
      },
      artifactRefs: [reconciliationArtifact],
    })

    updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'reporting', {
      at,
      actor: this.ctx.getSessionActor(session),
      reason: 'Reconciliation completed and final reporting can begin.',
      status: 'active',
      context: {
        finalObservedResultClassified: true,
      },
    })

    const report = this.transferHandler!.buildTransferCloseoutReport({
      session,
      run: updatedRun,
      at,
      broadcast,
      signatureResult,
      reconciliation,
    })
    const reportArtifact = await this.ctx.persistence.artifacts.write(
      {
        artifactType: 'audit_report',
        path: `runs/${run.runId}/closeout/${report.reportId}.json`,
      },
      report,
    )

    updatedRun = {
      ...updatedRun,
      reportArtifactPath: reportArtifact.path,
      reportRef: report.reportId,
      lastUpdatedAt: at,
    }
    await this.ctx.runs.put(updatedRun)
    await this.ctx.appendLedgerEvent({
      eventType: 'run.report_created',
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: 'reporting',
      actor: this.ctx.getSessionActor(session),
      refs: this.ctx.getRunRefs(updatedRun),
      summary: report.summary,
      payload: {
        reportId: report.reportId,
        finalStatus: report.finalStatus,
        reconciliationStatus: report.reconciliationStatus,
        transactionHash: report.transactionHash,
      },
      artifactRefs: [reportArtifact],
    })

    if (reconciliation.status === 'matched') {
      const completedRun = await this.ctx.transitionRunPhase(updatedRun, 'completed', {
        at,
        actor: this.ctx.getSessionActor(session),
        reason: 'Broadcast confirmed and reconciliation matched expected effects.',
        status: 'completed',
        context: {
          reportArtifactCreated: true,
        },
      })

      return {
        run: completedRun,
        output: [
          `Broadcast ${broadcast.broadcastId} confirmed.`,
          'Reconciliation matched expected execution effects.',
          `Execution report ${report.reportId} created.`,
        ],
      }
    }

    const failedRun = await this.ctx.transitionRunPhase(updatedRun, 'failed', {
      at,
      actor: this.ctx.getSessionActor(session),
      reason: 'Reconciliation did not match the expected execution outcome.',
      status: 'failed',
      context: {},
      payload: {
        reconciliationId: reconciliation.reconciliationId,
        status: reconciliation.status,
      },
    })

    return {
      run: failedRun,
      output: [
        `Broadcast ${broadcast.broadcastId} confirmed.`,
        'Reconciliation reported a mismatch.',
        `Execution report ${report.reportId} created.`,
      ],
    }
  }

  private findLatestPathContaining(
    paths: string[],
    token: string | undefined,
  ): string | undefined {
    if (!token) {
      return paths.at(-1)
    }

    for (let index = paths.length - 1; index >= 0; index -= 1) {
      const candidate = paths[index]
      if (candidate != null && candidate.includes(token)) {
        return candidate
      }
    }

    return paths.at(-1)
  }
}
