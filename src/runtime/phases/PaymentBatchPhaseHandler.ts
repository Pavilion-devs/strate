import type { ArtifactRef } from '../../contracts/ledger.js'
import type { ResolvedPolicyProfile } from '../../contracts/policyResolution.js'
import type { RunCloseoutReport } from '../../contracts/report.js'
import type { SignerProfile } from '../../contracts/signerProfile.js'
import type { IntentObject } from '../../contracts/intent.js'
import type { ResolvedTransferSourceWallet } from '../../contracts/wallet.js'
import type {
  KernelInput,
  RunState,
  SessionState,
} from '../../contracts/runtime.js'
import { parseTreasuryPaymentBatchRequestWithAI } from '../../treasury/AITreasuryPaymentBatchParser.js'
import { buildTreasuryPaymentBatchIntent } from '../../treasury/TreasuryPaymentBatchIntentBuilder.js'
import { validateTreasuryPaymentBatchIntent } from '../../treasury/validateTreasuryPaymentBatchIntent.js'
import { createPaymentBatchMaterialHash } from '../../treasury/paymentBatchMaterialHash.js'
import { TreasuryBalanceInspector } from '../../treasury/TreasuryBalanceInspector.js'
import type { PhaseHandlerContext } from './PhaseHandlerContext.js'
import type { SigningBroadcastHandler } from './SigningBroadcastHandler.js'
import type { ApprovalPackageHandler } from './ApprovalPackageHandler.js'

export class PaymentBatchPhaseHandler {
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
    const parsed = await parseTreasuryPaymentBatchRequestWithAI({
      text: input.text,
      payload: input.payload,
      hints: {
        sourceWalletId: session.orgContext.walletIds?.[0],
        treasuryId: session.orgContext.treasuryIds?.[0] ?? 'treasury_main',
      },
    })

    if (!parsed.ok) {
      const failedRun = await this.ctx.transitionRunPhase(run, 'failed', {
        at,
        actor: this.ctx.getSessionActor(session),
        reason: 'Payment batch request could not be parsed.',
        status: 'failed',
        context: {},
        payload: { error: parsed.error },
      })
      return { run: failedRun, output: [parsed.error] }
    }

    const intentId = this.ctx.createId('intent')
    const intent = buildTreasuryPaymentBatchIntent({
      intentId,
      createdAt: at,
      actor: {
        actorType: 'human',
        actorId: session.actorContext.actorId,
        sessionId: session.sessionId,
      },
      payload: parsed.payload,
      scope: {
        organizationId: session.orgContext.organizationId,
        treasuryId: parsed.payload.treasuryId,
        environment: session.environment,
      },
      originalRequestText: input.text,
    })

    const materialHash = createPaymentBatchMaterialHash(intent)
    const intentArtifact = await this.ctx.persistence.artifacts.write(
      {
        artifactType: 'intent_snapshot',
        path: `runs/${run.runId}/ledger/artifacts/intent/${intentId}-v1.json`,
      },
      intent,
    )

    let updatedRun: RunState = {
      ...run,
      intentRef: { intentId: intent.intentId, version: intent.version },
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
      summary: `Treasury payment batch intent ${intentId} created.`,
      payload: {
        actionType: intent.action.type,
        treasuryId: parsed.payload.treasuryId,
        paymentCount: parsed.payload.payments.length,
        materialHash,
      },
      artifactRefs: [intentArtifact],
    })

    updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'validation', {
      at,
      actor: this.ctx.getSessionActor(session),
      reason: 'Payment batch intent persisted.',
      context: { intentExists: true, intentPersisted: true },
    })

    const validation = validateTreasuryPaymentBatchIntent(intent)
    if (!validation.valid) {
      await this.ctx.appendLedgerEvent({
        eventType: 'intent.rejected',
        at,
        runId: run.runId,
        sessionId: run.sessionId,
        phase: 'validation',
        actor: this.ctx.getSessionActor(session),
        refs: this.ctx.getRunRefs(updatedRun),
        summary: `Payment batch intent ${intentId} failed validation.`,
        payload: { issues: validation.issues },
      })

      updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'failed', {
        at,
        actor: this.ctx.getSessionActor(session),
        reason: 'Payment batch intent validation failed.',
        status: 'failed',
        context: {},
        payload: { issues: validation.issues },
      })
      return {
        run: updatedRun,
        output: [
          `Persisted payment batch intent ${intentId}.`,
          `Validation failed: ${validation.issues.join(', ')}.`,
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
      summary: `Payment batch intent ${intentId} validated.`,
      payload: {},
    })

    updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'policy_resolution', {
      at,
      actor: this.ctx.getSessionActor(session),
      reason: 'Validation passed.',
      context: { validationPassed: true },
    })

    const policyCandidates = await this.ctx.getPolicyCandidates({
      session,
      run: updatedRun,
      kernelInput: input,
    })
    const resolvedPolicy = await this.ctx.policyResolver.resolve({
      runId: updatedRun.runId,
      sessionId: updatedRun.sessionId,
      environment: session.environment,
      actor: session.actorContext,
      intentRef: {
        intentId: intent.intentId,
        version: intent.version,
        actionType: 'treasury.payment_batch',
      },
      treasuryContext: {
        treasuryId: parsed.payload.treasuryId,
      },
      emergencyState: {
        haltActive: session.halted,
      },
      policyCandidates,
    })

    const policyArtifact = await this.ctx.persistence.artifacts.write(
      {
        artifactType: 'policy_snapshot',
        path: `runs/${run.runId}/ledger/artifacts/policy/resolution_${run.runId}.json`,
      },
      resolvedPolicy,
    )
    updatedRun = {
      ...updatedRun,
      policyRef: { resolutionId: resolvedPolicy.resolutionId },
      policyArtifactPath: policyArtifact.path,
      lastUpdatedAt: at,
    }
    await this.ctx.runs.put(updatedRun)

    if (resolvedPolicy.status === 'denied') {
      updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'failed', {
        at,
        actor: this.ctx.getSessionActor(session),
        reason: 'Policy denied the payment batch.',
        status: 'failed',
        context: {},
        payload: { reasonCodes: resolvedPolicy.reasonCodes },
      })
      return {
        run: updatedRun,
        output: [
          `Payment batch intent ${intentId} created.`,
          'Validation passed.',
          `Policy denied: ${resolvedPolicy.reasonCodes.join(', ')}.`,
        ],
      }
    }

    await this.ctx.appendLedgerEvent({
      eventType: 'policy.resolved',
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: 'policy_resolution',
      actor: this.ctx.getSessionActor(session),
      refs: this.ctx.getRunRefs(updatedRun),
      summary: `Policy resolved as ${resolvedPolicy.status}.`,
      payload: { status: resolvedPolicy.status },
      artifactRefs: [policyArtifact],
    })

    updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'planning', {
      at,
      actor: this.ctx.getSessionActor(session),
      reason: 'Policy allowed. Planning payment batch.',
      context: {
        resolvedPolicyExists: true,
        actionAllowedToBePlanned: true,
        planExists: false,
        planPolicyCompatible: false,
      },
    })

    if (intent.action.type !== 'treasury.payment_batch') {
      updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'failed', {
        at,
        actor: this.ctx.getSessionActor(session),
        reason: 'Intent payload mismatch.',
        status: 'failed',
        context: {},
      })
      return { run: updatedRun, output: ['Intent payload mismatch.'] }
    }

    const payload = intent.action.payload
    const totalAmount = payload.payments
      .reduce((sum, payment) => sum + Number(payment.amount), 0)
      .toString()
    const sourceWalletId =
      payload.sourceWalletId ??
      session.orgContext.walletIds?.[0] ??
      `wallet_treasury_${payload.treasuryId}`
    const sourceWallet = await this.ctx.walletRegistry.get(sourceWalletId)

    const inspector = new TreasuryBalanceInspector()
    const sourceBalance =
      sourceWallet?.address != null
        ? await inspector.inspectWallet(
            sourceWallet,
            payload.assetSymbol,
            payload.chainId,
          )
        : undefined
    const hasSpendableBalance =
      sourceBalance == null ||
      sourceBalance.spendableBalance >= Number(totalAmount)
    const planId = this.ctx.createId('batch_plan')
    const plan = {
      planId,
      sourceWalletId,
      paymentCount: payload.payments.length,
      totalAmount,
      assetSymbol: payload.assetSymbol,
      chainId: payload.chainId,
      balanceCheckSkipped: sourceBalance == null,
      spendableBalance: sourceBalance?.spendableBalance,
      canExecute: hasSpendableBalance,
      reasonCodes: hasSpendableBalance ? [] : ['source.insufficient_spendable_balance'],
    }
    const planArtifact = await this.ctx.persistence.artifacts.write(
      {
        artifactType: 'simulation_record',
        path: `runs/${run.runId}/ledger/artifacts/plan/payment_batch_plan_${planId}.json`,
      },
      plan,
    )
    await this.ctx.appendLedgerEvent({
      eventType: 'treasury.payment_batch_planned',
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: 'planning',
      actor: this.ctx.getSessionActor(session),
      refs: this.ctx.getRunRefs(updatedRun),
      summary: hasSpendableBalance
        ? `Payment batch planned: ${payload.payments.length} payments totaling ${totalAmount} ${payload.assetSymbol}.`
        : `Payment batch planning failed: insufficient spendable balance for ${totalAmount} ${payload.assetSymbol}.`,
      payload: plan as unknown as Record<string, unknown>,
      artifactRefs: [planArtifact],
    })

    if (!hasSpendableBalance) {
      updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'failed', {
        at,
        actor: this.ctx.getSessionActor(session),
        reason: 'Insufficient spendable balance for payment batch.',
        status: 'failed',
        context: {},
      })
      return {
        run: updatedRun,
        output: [
          `Payment batch intent ${intentId} created.`,
          'Validation passed.',
          `Policy resolved as ${resolvedPolicy.status}.`,
          `Planning failed: insufficient spendable balance for ${totalAmount} ${payload.assetSymbol}.`,
        ],
      }
    }

    updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'simulation', {
      at,
      actor: this.ctx.getSessionActor(session),
      reason: 'Plan feasible. Running payment batch simulation.',
      context: { planExists: true, planPolicyCompatible: true },
    })

    const simulation = await this.ctx.simulationEngine.simulatePaymentBatch({
      runId: run.runId,
      sessionId: session.sessionId,
      intent,
      resolvedPolicy,
      materialHash,
    })

    const simArtifact = await this.ctx.persistence.artifacts.write(
      {
        artifactType: 'simulation_record',
        path: `runs/${run.runId}/ledger/artifacts/simulation/${simulation.simulationId}.json`,
      },
      simulation,
    )
    updatedRun = {
      ...updatedRun,
      simulationRefs: [...updatedRun.simulationRefs, simulation.simulationId],
      simulationArtifactPaths: [...updatedRun.simulationArtifactPaths, simArtifact.path],
      lastUpdatedAt: at,
    }
    await this.ctx.runs.put(updatedRun)

    if (simulation.status !== 'succeeded') {
      updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'failed', {
        at,
        actor: this.ctx.getSessionActor(session),
        reason: 'Payment batch simulation failed.',
        status: 'failed',
        context: {},
      })
      return {
        run: updatedRun,
        output: [
          `Payment batch intent ${intentId} created.`,
          'Validation passed.',
          `Policy resolved as ${resolvedPolicy.status}.`,
          'Simulation failed.',
        ],
      }
    }

    await this.ctx.appendLedgerEvent({
      eventType: 'simulation.completed',
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: 'simulation',
      actor: this.ctx.getSessionActor(session),
      refs: this.ctx.getRunRefs(updatedRun),
      summary: `Simulation completed for payment batch: ${simulation.summary}`,
      payload: {
        simulationId: simulation.simulationId,
        status: simulation.status,
      },
      artifactRefs: [simArtifact],
    })

    updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'approval', {
      at,
      actor: this.ctx.getSessionActor(session),
      reason: 'Simulation passed. Requesting approval for payment batch.',
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
        path: `runs/${run.runId}/ledger/artifacts/approval/${approvalState.approvalStateId}.json`,
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
      summary:
        approvalState.status === 'not_required'
          ? `Approval not required for payment batch totaling ${totalAmount} ${payload.assetSymbol}.`
          : `Approval required for payment batch totaling ${totalAmount} ${payload.assetSymbol}.`,
      payload: {
        approvalStateId: approvalState.approvalStateId,
        approvalClass: approvalState.approvalClass,
        status: approvalState.status,
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
        reason: 'Approval evaluation blocked payment batch execution.',
        status: 'failed',
        context: {},
      })
      return {
        run: updatedRun,
        output: [
          `Persisted payment batch intent ${intentId}.`,
          'Validation passed.',
          `Policy resolved as ${resolvedPolicy.status}.`,
          `Planning passed: ${payload.payments.length} payments totaling ${totalAmount} ${payload.assetSymbol}.`,
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
          `Persisted payment batch intent ${intentId}.`,
          'Validation passed.',
          `Policy resolved as ${resolvedPolicy.status}.`,
          `Planning passed: ${payload.payments.length} payments totaling ${totalAmount} ${payload.assetSymbol}.`,
          'Simulation completed.',
          ...signingResult.output,
        ],
      }
    }

    return {
      run: updatedRun,
      output: [
        `Persisted payment batch intent ${intentId}.`,
        'Validation passed.',
        `Policy resolved as ${resolvedPolicy.status}.`,
        `Planning passed: ${payload.payments.length} payments totaling ${totalAmount} ${payload.assetSymbol}.`,
        'Simulation completed.',
        'Approval is now pending.',
      ],
    }
  }

  async resolvePaymentBatchSigningContext(
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
    if (intent.action.type !== 'treasury.payment_batch') {
      throw new Error(
        `Batch signing context only supports treasury.payment_batch, received ${intent.action.type}.`,
      )
    }

    const sourceWalletId =
      intent.action.payload.sourceWalletId ??
      session.orgContext.walletIds?.[0] ??
      `wallet_treasury_${intent.action.payload.treasuryId}`

    const resolvedWallet = await this.ctx.walletProvider.resolveTransferSource({
      walletId: sourceWalletId,
      chainId: intent.action.payload.chainId,
      environment: session.environment,
      actionType: 'asset.transfer',
      requiredSignerClass: resolvedPolicy.signing.requiredSignerClass,
      allowedSignerClasses: resolvedPolicy.signing.allowedSignerClasses,
    })

    const signerProfile = this.ctx.signerProfiles.resolveCompatible({
      signerProfileId: resolvedWallet.signerProfileId,
      walletId: resolvedWallet.wallet.walletId,
      chainId: intent.action.payload.chainId,
      allowedSignerClasses: resolvedPolicy.signing.allowedSignerClasses,
      requiredSignerClass: resolvedPolicy.signing.requiredSignerClass,
    })

    const resolvedWalletContext = {
      providerId: resolvedWallet.providerId,
      address: resolvedWallet.address,
      wallet: {
        ...resolvedWallet.wallet,
        updatedAt: at,
      },
      resolvedWallet: {
        ...resolvedWallet,
        wallet: {
          ...resolvedWallet.wallet,
          updatedAt: at,
        },
      },
      signerProfile,
    }

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

  buildRunCloseoutReport(input: {
    session: SessionState
    run: RunState
    at: string
    summary: string
    notes: string[]
    walletIds?: string[]
  }): RunCloseoutReport {
    return {
      reportId: this.ctx.createId('report'),
      runId: input.run.runId,
      sessionId: input.session.sessionId,
      actionType: input.run.actionType as import('../../contracts/intent.js').IntentActionType,
      createdAt: input.at,
      finalStatus: 'completed',
      summary: input.summary,
      intentRef: input.run.intentRef,
      notes: input.notes,
      walletIds: input.walletIds,
    }
  }
}
