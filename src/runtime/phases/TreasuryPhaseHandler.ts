import type { ArtifactRef } from '../../contracts/ledger.js'
import type {
  KernelInput,
  RunState,
  SessionState,
} from '../../contracts/runtime.js'
import { parseTreasuryRebalanceRequestWithAI } from '../../treasury/AITreasuryRebalanceParser.js'
import { buildTreasuryRebalanceIntent } from '../../treasury/TreasuryRebalanceIntentBuilder.js'
import { validateTreasuryRebalanceIntent } from '../../treasury/validateTreasuryRebalanceIntent.js'
import { TreasuryBalanceInspector } from '../../treasury/TreasuryBalanceInspector.js'
import type { PhaseHandlerContext } from './PhaseHandlerContext.js'
import type { SigningBroadcastHandler } from './SigningBroadcastHandler.js'
import type { ApprovalPackageHandler } from './ApprovalPackageHandler.js'

export class TreasuryPhaseHandler {
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
    // ── Phase 1: Parse ────────────────────────────────────────────────────────
    const parsed = await parseTreasuryRebalanceRequestWithAI({
      text: input.text,
      payload: input.payload,
    })

    if (!parsed.ok) {
      const failedRun = await this.ctx.transitionRunPhase(run, 'failed', {
        at, actor: this.ctx.getSessionActor(session),
        reason: 'Rebalance request could not be parsed.', status: 'failed',
        context: {}, payload: { error: parsed.error },
      })
      return { run: failedRun, output: [parsed.error] }
    }

    // ── Phase 2: Build + Persist Intent ──────────────────────────────────────
    const intentId = this.ctx.createId('intent')
    const intent = buildTreasuryRebalanceIntent({
      intentId,
      createdAt: at,
      actor: { actorType: 'human', actorId: session.actorContext.actorId, sessionId: session.sessionId },
      payload: parsed.payload,
      scope: {
        organizationId: session.orgContext.organizationId,
        treasuryId: parsed.payload.treasuryId,
        environment: session.environment,
      },
      originalRequestText: input.text,
    })

    let updatedRun: RunState = {
      ...run,
      intentRef: { intentId: intent.intentId, version: intent.version },
      lastUpdatedAt: at,
    }
    await this.ctx.runs.put(updatedRun)

    const intentArtifact = await this.ctx.persistence.artifacts.write(
      { artifactType: 'intent_snapshot', path: `runs/${run.runId}/ledger/artifacts/intent/${intentId}-v1.json` },
      intent,
    )
    updatedRun = {
      ...updatedRun,
      intentArtifactPath: intentArtifact.path,
      lastUpdatedAt: at,
    }
    await this.ctx.runs.put(updatedRun)

    await this.ctx.appendLedgerEvent({
      eventType: 'intent.created', at, runId: run.runId, sessionId: run.sessionId,
      phase: 'intent_capture', actor: this.ctx.getSessionActor(session),
      refs: this.ctx.getRunRefs(updatedRun),
      summary: `Treasury rebalance intent ${intentId} created.`,
      payload: { actionType: intent.action.type, treasuryId: parsed.payload.treasuryId },
      artifactRefs: [intentArtifact],
    })

    // ── Phase 3: Validate ─────────────────────────────────────────────────────
    updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'validation', {
      at, actor: this.ctx.getSessionActor(session),
      reason: 'Rebalance intent persisted.', context: { intentExists: true, intentPersisted: true },
    })

    const validation = validateTreasuryRebalanceIntent(intent)
    if (!validation.valid) {
      updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'failed', {
        at, actor: this.ctx.getSessionActor(session),
        reason: 'Validation failed.', status: 'failed', context: {},
        payload: { issues: validation.issues },
      })
      return {
        run: updatedRun,
        output: [`Persisted rebalance intent ${intentId}.`, `Validation failed: ${validation.issues.join(', ')}.`],
      }
    }

    await this.ctx.appendLedgerEvent({
      eventType: 'intent.validated', at, runId: run.runId, sessionId: run.sessionId,
      phase: 'validation', actor: this.ctx.getSessionActor(session),
      refs: this.ctx.getRunRefs(updatedRun),
      summary: `Rebalance intent ${intentId} validated.`,
      payload: {},
    })

    // ── Phase 4: Policy Resolution ────────────────────────────────────────────
    updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'policy_resolution', {
      at, actor: this.ctx.getSessionActor(session),
      reason: 'Validation passed.', context: { validationPassed: true },
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
        actionType: 'treasury.rebalance',
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
      { artifactType: 'policy_snapshot', path: `runs/${run.runId}/ledger/artifacts/policy/resolution_${run.runId}.json` },
      resolvedPolicy,
    )
    updatedRun = { ...updatedRun, policyRef: { resolutionId: resolvedPolicy.resolutionId }, policyArtifactPath: policyArtifact.path, lastUpdatedAt: at }
    await this.ctx.runs.put(updatedRun)

    if (resolvedPolicy.status === 'denied') {
      updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'failed', {
        at, actor: this.ctx.getSessionActor(session),
        reason: 'Policy denied the rebalance.', status: 'failed', context: {},
        payload: { reasonCodes: resolvedPolicy.reasonCodes },
      })
      return {
        run: updatedRun,
        output: [`Rebalance intent ${intentId} created.`, `Validation passed.`, `Policy denied: ${resolvedPolicy.reasonCodes.join(', ')}.`],
      }
    }

    await this.ctx.appendLedgerEvent({
      eventType: 'policy.resolved', at, runId: run.runId, sessionId: run.sessionId,
      phase: 'policy_resolution', actor: this.ctx.getSessionActor(session),
      refs: this.ctx.getRunRefs(updatedRun),
      summary: `Policy resolved as ${resolvedPolicy.status}.`,
      payload: { status: resolvedPolicy.status },
      artifactRefs: [policyArtifact],
    })

    // ── Phase 5: Balance Inspection + Planning ────────────────────────────────
    updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'planning', {
      at, actor: this.ctx.getSessionActor(session),
      reason: 'Policy allowed. Inspecting treasury balances.',
      context: {
        resolvedPolicyExists: true,
        actionAllowedToBePlanned: true,
        planExists: false,
        planPolicyCompatible: false,
      },
    })

    const payload = intent.action.type === 'treasury.rebalance' ? intent.action.payload : undefined
    if (!payload) {
      updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'failed', {
        at, actor: this.ctx.getSessionActor(session),
        reason: 'Intent payload mismatch.', status: 'failed', context: {},
      })
      return { run: updatedRun, output: ['Intent payload mismatch.'] }
    }

    // Resolve source wallet
    const sourceWalletId = payload.sourceWalletId ?? session.orgContext.walletIds?.[0] ?? `wallet_treasury_${payload.treasuryId}`
    let sourceWallet = await this.ctx.walletRegistry.get(sourceWalletId)
    if (!sourceWallet) {
      // Create a placeholder for planning purposes
      sourceWallet = {
        walletId: sourceWalletId,
        createdAt: at, updatedAt: at,
        state: 'active_full', walletType: 'treasury',
        organizationId: session.orgContext.organizationId,
        complianceStatus: 'approved', policyAttachmentStatus: 'attached',
        signerHealthStatus: 'healthy', trustStatus: 'sufficient',
      }
    }

    const destinationWallet = payload.destinationWalletId
      ? (await this.ctx.walletRegistry.get(payload.destinationWalletId)) ?? null
      : null

    const inspector = new TreasuryBalanceInspector()
    const plan = await inspector.planRebalance(payload, sourceWallet, destinationWallet)

    const planArtifact = await this.ctx.persistence.artifacts.write(
      { artifactType: 'simulation_record', path: `runs/${run.runId}/ledger/artifacts/plan/rebalance_plan_${plan.planId}.json` },
      plan,
    )
    await this.ctx.appendLedgerEvent({
      eventType: 'treasury.rebalance_planned', at, runId: run.runId, sessionId: run.sessionId,
      phase: 'planning', actor: this.ctx.getSessionActor(session),
      refs: this.ctx.getRunRefs(updatedRun),
      summary: plan.canExecute
        ? `Rebalance plan: ${plan.feasibleAmount} ${plan.assetSymbol} is available to move.`
        : `Rebalance plan: insufficient balance. Available: ${plan.feasibleAmount} ${plan.assetSymbol}, requested: ${plan.requestedAmount}.`,
      payload: {
        planId: plan.planId,
        requestedAmount: plan.requestedAmount,
        feasibleAmount: plan.feasibleAmount,
        canExecute: plan.canExecute,
        sourceFloorSatisfied: plan.sourceFloorSatisfied,
        reasonCodes: plan.reasonCodes,
      },
      artifactRefs: [planArtifact],
    })

    if (!plan.canExecute) {
      updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'failed', {
        at, actor: this.ctx.getSessionActor(session),
        reason: `Insufficient balance: ${plan.reasonCodes.join(', ')}.`,
        status: 'failed', context: {},
      })
      return {
        run: updatedRun,
        output: [
          `Rebalance intent ${intentId} created.`, 'Validation passed.', `Policy resolved as ${resolvedPolicy.status}.`,
          `Balance inspection: cannot execute. Available ${plan.feasibleAmount} ${plan.assetSymbol}, requested ${plan.requestedAmount}.`,
          plan.reasonCodes.length > 0 ? `Reason: ${plan.reasonCodes.join(', ')}.` : '',
        ].filter(Boolean),
      }
    }

    const destinationAddress = destinationWallet?.address
    if (!destinationAddress) {
      updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'failed', {
        at,
        actor: this.ctx.getSessionActor(session),
        reason:
          'Rebalance execution requires a destination wallet with an address.',
        status: 'failed',
        context: {},
        payload: {
          destinationWalletId: payload.destinationWalletId,
        },
      })
      return {
        run: updatedRun,
        output: [
          `Rebalance intent ${intentId} created.`,
          'Validation passed.',
          `Policy resolved as ${resolvedPolicy.status}.`,
          `Balance inspection: ${plan.feasibleAmount} ${payload.assetSymbol} available to move.`,
          'Missing destination wallet address. Specify destinationWalletId mapped to a registered wallet with an address.',
        ],
      }
    }

    // ── Phase 6: Simulation ───────────────────────────────────────────────────
    updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'simulation', {
      at, actor: this.ctx.getSessionActor(session),
      reason: 'Balance plan feasible. Running simulation.',
      context: { planExists: true, planPolicyCompatible: true },
    })

    // Build a transfer intent for the simulation engine to validate
    const simulationIntent = {
      ...intent,
      action: {
        type: 'asset.transfer' as const,
        payload: {
          sourceWalletId,
          destinationAddress,
          chainId: payload.chainId,
          assetSymbol: payload.assetSymbol,
          amount: String(plan.feasibleAmount),
        },
      },
    }

    const materialHash = `rebalance:${intentId}:${plan.planId}`
    const simulation = await this.ctx.simulationEngine.simulateTransfer({
      runId: run.runId,
      sessionId: session.sessionId,
      intent: simulationIntent,
      resolvedPolicy,
      materialHash,
    })

    const simArtifact = await this.ctx.persistence.artifacts.write(
      { artifactType: 'simulation_record', path: `runs/${run.runId}/ledger/artifacts/simulation/${simulation.simulationId}.json` },
      simulation,
    )
    updatedRun = {
      ...updatedRun,
      simulationRefs: [...updatedRun.simulationRefs, simulation.simulationId],
      simulationArtifactPaths: [...updatedRun.simulationArtifactPaths, simArtifact.path],
      lastUpdatedAt: at,
    }
    await this.ctx.runs.put(updatedRun)

    if (simulation.status === 'failed') {
      updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'failed', {
        at, actor: this.ctx.getSessionActor(session),
        reason: 'Simulation failed.', status: 'failed', context: {},
      })
      return {
        run: updatedRun,
        output: [`Rebalance intent ${intentId} created.`, 'Validation passed.', `Policy resolved as ${resolvedPolicy.status}.`, 'Balance inspection passed.', 'Simulation failed.'],
      }
    }

    await this.ctx.appendLedgerEvent({
      eventType: 'simulation.completed', at, runId: run.runId, sessionId: run.sessionId,
      phase: 'simulation', actor: this.ctx.getSessionActor(session),
      refs: this.ctx.getRunRefs(updatedRun),
      summary: `Simulation completed for rebalance: ${simulation.summary}`,
      payload: { simulationId: simulation.simulationId, status: simulation.status },
      artifactRefs: [simArtifact],
    })

    // ── Phase 7: Approval ─────────────────────────────────────────────────────
    updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'approval', {
      at, actor: this.ctx.getSessionActor(session),
      reason: 'Simulation passed. Requesting approval for treasury rebalance.',
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
      { artifactType: 'approval_record', path: `runs/${run.runId}/ledger/artifacts/approval/${approvalState.approvalStateId}.json` },
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
      phase: 'approval', actor: this.ctx.getSessionActor(session),
      refs: this.ctx.getRunRefs(updatedRun),
      summary:
        approvalState.status === 'not_required'
          ? `Approval not required for treasury rebalance of ${plan.feasibleAmount} ${payload.assetSymbol}.`
          : `Approval required for treasury rebalance of ${plan.feasibleAmount} ${payload.assetSymbol}.`,
      payload: {
        approvalStateId: approvalState.approvalStateId,
        approvalClass: approvalState.approvalClass,
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
        reason: 'Approval evaluation blocked treasury rebalance execution.',
        status: 'failed',
        context: {},
        payload: {
          approvalStateId: approvalState.approvalStateId,
        },
      })
      return {
        run: updatedRun,
        output: [
          `Persisted rebalance intent ${intentId}.`,
          'Validation passed.',
          `Policy resolved as ${resolvedPolicy.status}.`,
          `Balance inspection: ${plan.feasibleAmount} ${payload.assetSymbol} available to move.`,
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
          `Persisted rebalance intent ${intentId}.`,
          'Validation passed.',
          `Policy resolved as ${resolvedPolicy.status}.`,
          `Balance inspection: ${plan.feasibleAmount} ${payload.assetSymbol} available to move.`,
          'Simulation completed.',
          ...signingResult.output,
        ],
      }
    }

    return {
      run: updatedRun,
      output: [
        `Persisted rebalance intent ${intentId}.`,
        'Validation passed.', `Policy resolved as ${resolvedPolicy.status}.`,
        `Balance inspection: ${plan.feasibleAmount} ${payload.assetSymbol} available to move.`,
        `Simulation completed.`,
        `Approval is now pending — ${plan.feasibleAmount} ${payload.assetSymbol} on ${payload.chainId} (${payload.objective}).`,
      ],
    }
  }
}
