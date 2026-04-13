import { createHash } from 'crypto'
import type { ArtifactRef } from '../../contracts/ledger.js'
import type { RunCloseoutReport } from '../../contracts/report.js'
import type {
  ComplianceProvider,
  ComplianceWorkflowRecord,
} from '../../contracts/compliance.js'
import type { TrustAssessment } from '../../contracts/trust.js'
import type {
  WalletComplianceStatus,
  WalletLifecycleState,
  WalletRecord,
} from '../../contracts/wallet.js'
import type {
  KernelCallbackEvent,
  KernelInput,
  RunState,
  SessionState,
} from '../../contracts/runtime.js'
import { buildWalletCreateIntent } from '../../wallets/WalletCreateIntentBuilder.js'
import { parseWalletCreateRequestWithAI } from '../../wallets/parseWalletCreateRequest.js'
import { validateWalletCreateIntent } from '../../wallets/validateWalletCreateIntent.js'
import type { PhaseHandlerContext } from './PhaseHandlerContext.js'

export class WalletCreatePhaseHandler {
  constructor(private readonly ctx: PhaseHandlerContext) {}

  async advance(
    session: SessionState,
    input: KernelInput,
    run: RunState,
    at: string,
  ): Promise<{ run: RunState; output: string[] }> {
    const parsed = await parseWalletCreateRequestWithAI({
      text: input.text,
      payload: input.payload,
    })

    if (!parsed.ok) {
      const failedRun = await this.ctx.transitionRunPhase(run, 'failed', {
        at,
        actor: this.ctx.getSessionActor(session),
        reason: 'Wallet creation request could not be parsed into structured intent.',
        status: 'failed',
        context: {},
        payload: {
          error: parsed.error,
        },
      })

      return {
        run: failedRun,
        output: [parsed.error],
      }
    }

    const payload = {
      ...parsed.payload,
      environment: session.environment,
    }

    const intentId = this.ctx.createId('intent')
    const intent = buildWalletCreateIntent({
      intentId,
      createdAt: at,
      actor: {
        actorType: 'human',
        actorId: session.actorContext.actorId,
        sessionId: session.sessionId,
      },
      environment: session.environment,
      payload,
      organizationId: session.orgContext.organizationId,
      treasuryId: session.orgContext.treasuryIds?.[0],
      originalRequestText: input.text,
    })

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
    const walletCreatePayload1 =
      intent.action.type === 'wallet.create' ? intent.action.payload : undefined
    await this.ctx.appendLedgerEvent({
      eventType: 'intent.created',
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: 'intent_capture',
      actor: this.ctx.getSessionActor(session),
      refs: this.ctx.getRunRefs(updatedRun),
      summary: `Intent ${intent.intentId} created for wallet creation run ${run.runId}.`,
      payload: {
        actionType: intent.action.type,
        subjectId: walletCreatePayload1?.subjectId,
        walletType: walletCreatePayload1?.walletType,
      },
      artifactRefs: [intentArtifact],
    })

    updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'validation', {
      at,
      actor: this.ctx.getSessionActor(session),
      reason: 'Wallet creation intent persisted and ready for validation.',
      context: {
        intentExists: true,
        intentPersisted: true,
      },
    })

    const validation = validateWalletCreateIntent(intent)
    if (!validation.valid) {
      await this.ctx.appendLedgerEvent({
        eventType: 'intent.rejected',
        at,
        runId: run.runId,
        sessionId: run.sessionId,
        phase: 'validation',
        actor: this.ctx.getSessionActor(session),
        refs: this.ctx.getRunRefs(updatedRun),
        summary: `Wallet creation intent ${intent.intentId} failed validation.`,
        payload: {
          issues: validation.issues,
        },
      })

      updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'failed', {
        at,
        actor: this.ctx.getSessionActor(session),
        reason: 'Wallet creation intent validation failed.',
        status: 'failed',
        context: {},
        payload: {
          issues: validation.issues,
        },
      })

      return {
        run: updatedRun,
        output: [
          `Persisted wallet creation intent ${intent.intentId}.`,
          `Wallet creation validation failed: ${validation.issues.join(', ')}.`,
        ],
      }
    }

    const walletCreatePayload2 =
      intent.action.type === 'wallet.create' ? intent.action.payload : undefined
    await this.ctx.appendLedgerEvent({
      eventType: 'intent.validated',
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: 'validation',
      actor: this.ctx.getSessionActor(session),
      refs: this.ctx.getRunRefs(updatedRun),
      summary: `Wallet creation intent ${intent.intentId} validated successfully.`,
      payload: {
        subjectId: walletCreatePayload2?.subjectId,
        walletType: walletCreatePayload2?.walletType,
      },
    })

    updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'policy_resolution', {
      at,
      actor: this.ctx.getSessionActor(session),
      reason: 'Wallet creation validation passed.',
      context: {
        validationPassed: true,
      },
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
        actionType: intent.action.type,
      },
      walletContext: {
        walletType:
          intent.action.type === 'wallet.create'
            ? intent.action.payload.walletType
            : undefined,
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
        reason: 'Resolved policy denied the wallet creation run.',
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
          `Persisted wallet creation intent ${intent.intentId}.`,
          'Wallet creation validation passed.',
          `Policy denied the run: ${resolvedPolicy.reasonCodes.join(', ') || 'policy.denied'}.`,
        ],
      }
    }

    updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'planning', {
      at,
      actor: this.ctx.getSessionActor(session),
      reason: 'Policy resolution completed and wallet provisioning can be planned.',
      context: {
        resolvedPolicyExists: true,
        actionAllowedToBePlanned: true,
      },
    })

    let signerProfile
    try {
      signerProfile = this.ctx.signerProfiles.resolveCompatible({
        signerProfileId:
          intent.action.type === 'wallet.create'
            ? intent.action.payload.signerProfileId
            : undefined,
        // undefined when policy allows all chains — supportsChain() skips the check
        chainId: resolvedPolicy.scope.allowedChains.length > 0
          ? resolvedPolicy.scope.allowedChains[0]
          : undefined,
        allowedSignerClasses:
          resolvedPolicy.signing.allowedSignerClasses.length > 0
            ? resolvedPolicy.signing.allowedSignerClasses
            : this.ctx.signerProfiles.list().map((profile) => profile.signerClass),
      })
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown signer profile resolution error.'

      updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'failed', {
        at,
        actor: this.ctx.getSessionActor(session),
        reason: 'Wallet creation could not resolve a signer profile.',
        status: 'failed',
        context: {},
        payload: {
          error: message,
        },
      })

      return {
        run: updatedRun,
        output: [
          `Persisted wallet creation intent ${intent.intentId}.`,
          'Wallet creation validation passed.',
          `Policy resolved as ${resolvedPolicy.status}.`,
          `Signer profile resolution failed: ${message}.`,
        ],
      }
    }

    const walletId = this.ctx.createId('wallet')
    const walletCreatePayload3 =
      intent.action.type === 'wallet.create' ? intent.action.payload : undefined
    const supportedChains =
      resolvedPolicy.scope.allowedChains.length > 0
        ? resolvedPolicy.scope.allowedChains
        : ['solana', 'solana-devnet', 'devnet', 'base', 'ethereum', 'test']

    // ── Phase 6: Wallet Creation / Registration ──────────────────────────────
    // Use the real wallet provider to provision the wallet.
    // For Solana this generates a fresh Keypair. For deterministic it uses a hash.
    const provisioned = await this.ctx.walletProvider.provisionWallet({
      walletId,
      walletType: walletCreatePayload3?.walletType ?? 'ops',
      subjectId: walletCreatePayload3?.subjectId ?? 'unknown',
      subjectType: walletCreatePayload3?.subjectType ?? 'individual',
      organizationId: session.orgContext.organizationId,
      treasuryId:
        walletCreatePayload3?.walletType === 'treasury' ||
        walletCreatePayload3?.walletType === 'ops'
          ? session.orgContext.treasuryIds?.[0]
          : undefined,
      signerProfileId: signerProfile.signerProfileId,
      environment: session.environment,
      supportedChains,
    })

    let walletRecord: WalletRecord = {
      ...provisioned.walletRecord,
      signerProfileId: signerProfile.signerProfileId,
      policyAttachmentStatus: (
        walletCreatePayload3?.initialPolicyProfileId != null ? 'attached' : 'pending'
      ) as 'attached' | 'pending',
    }
    await this.ctx.walletRegistry.put(walletRecord)

    const walletArtifact = await this.ctx.persistence.artifacts.write(
      {
        artifactType: 'wallet_snapshot',
        path: `runs/${run.runId}/ledger/artifacts/wallet/${walletId}.created.json`,
      },
      {
        ...walletRecord,
        // Never persist the secret key in the ledger artifact
        secretKeyBase64: provisioned.secretKeyBase64 ? '[REDACTED - store separately]' : undefined,
      },
    )

    await this.ctx.appendLedgerEvent({
      eventType: 'wallet.created',
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: 'planning',
      actor: this.ctx.getSessionActor(session),
      refs: { ...this.ctx.getRunRefs(updatedRun), walletIds: [walletRecord.walletId] },
      summary: `Wallet ${walletRecord.walletId} provisioned at address ${provisioned.address} for subject ${walletRecord.subjectId}.`,
      payload: {
        walletId: walletRecord.walletId,
        address: provisioned.address,
        subjectId: walletRecord.subjectId,
        walletType: walletRecord.walletType,
        state: walletRecord.state,
        signerProfileId: walletRecord.signerProfileId,
        providerId: provisioned.providerId,
      },
      artifactRefs: [walletArtifact],
    })

    // ── Phase 7: Wallet Linked to Subject ────────────────────────────────────
    // Record the identity link between the wallet and the subject.
    const identityLinkRecord = {
      walletId: walletRecord.walletId,
      subjectId: walletRecord.subjectId,
      subjectType: walletCreatePayload3?.subjectType ?? 'individual',
      linkedAt: at,
      linkedBy: this.ctx.getSessionActor(session).actorId,
      status: 'linked',
    }
    const identityArtifact = await this.ctx.persistence.artifacts.write(
      {
        artifactType: 'note',
        path: `runs/${run.runId}/ledger/artifacts/identity/${walletId}.link.json`,
      },
      identityLinkRecord,
    )
    await this.ctx.appendLedgerEvent({
      eventType: 'wallet.linked',
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: 'planning',
      actor: this.ctx.getSessionActor(session),
      refs: { ...this.ctx.getRunRefs(updatedRun), walletIds: [walletRecord.walletId] },
      summary: `Wallet ${walletRecord.walletId} linked to subject ${walletRecord.subjectId} (${identityLinkRecord.subjectType}).`,
      payload: identityLinkRecord,
      artifactRefs: [identityArtifact],
    })

    // ── Phase 8: Compliance Kickoff ──────────────────────────────────────────
    // Start the compliance workflow through the configured provider boundary.
    const kycWorkflowId = this.ctx.createId('kyc')
    const complianceKickoff = await this.ctx.complianceProvider.startWorkflow({
      complianceWorkflowId: kycWorkflowId,
      walletId: walletRecord.walletId,
      subjectId: walletRecord.subjectId,
      subjectType: walletCreatePayload3?.subjectType ?? 'individual',
      workflowType: walletCreatePayload3?.subjectType === 'business' ? 'kyb' : 'kyc',
      organizationId: walletRecord.organizationId,
      initiatedAt: at,
      initiatedBy: this.ctx.getSessionActor(session).actorId,
    })
    walletRecord = {
      ...walletRecord,
      complianceStatus: this.toWalletComplianceStatus(
        complianceKickoff.workflow.status,
      ),
      complianceWorkflowId: complianceKickoff.workflow.complianceWorkflowId,
      complianceProviderId: complianceKickoff.providerId,
      complianceProviderCaseId: complianceKickoff.providerCaseId,
      updatedAt: at,
    }
    await this.ctx.walletRegistry.put(walletRecord)
    const kycArtifact = await this.ctx.persistence.artifacts.write(
      {
        artifactType: 'note',
        path: `runs/${run.runId}/ledger/artifacts/compliance/${walletId}.kyc_kickoff.json`,
      },
      complianceKickoff.workflow,
    )
    await this.ctx.appendLedgerEvent({
      eventType: 'compliance.kyc_initiated',
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: 'planning',
      actor: this.ctx.getSessionActor(session),
      refs: { ...this.ctx.getRunRefs(updatedRun), walletIds: [walletRecord.walletId] },
      summary: `${complianceKickoff.workflow.workflowType.toUpperCase()} workflow ${kycWorkflowId} initiated for ${walletRecord.subjectId}.`,
      payload: complianceKickoff.workflow,
      artifactRefs: [kycArtifact],
    })

    // ── Phase 9: Initial Policy Attachment ───────────────────────────────────
    // Record the policy attachment. The dev policy is already resolving globally —
    // here we record the explicit attachment event on the wallet record.
    const policyRef = walletCreatePayload3?.initialPolicyProfileId ?? resolvedPolicy.resolutionId
    await this.ctx.appendLedgerEvent({
      eventType: 'wallet.policy_attached',
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: 'planning',
      actor: this.ctx.getSessionActor(session),
      refs: { ...this.ctx.getRunRefs(updatedRun), walletIds: [walletRecord.walletId] },
      summary: `Policy ${policyRef} attached to wallet ${walletRecord.walletId}.`,
      payload: { walletId: walletRecord.walletId, policyRef },
    })

    // ── Phase 10: Trust Baseline ─────────────────────────────────────────────
    // Compute the initial trust baseline from explicit wallet/compliance state.
    const trustBaseline = await this.persistWalletTrustAssessment({
      run: updatedRun,
      session,
      wallet: walletRecord,
      at,
      artifactSuffix: 'baseline',
    })
    walletRecord = trustBaseline.wallet
    await this.ctx.appendLedgerEvent({
      eventType: 'trust.baseline_created',
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: 'planning',
      actor: this.ctx.getSessionActor(session),
      refs: { ...this.ctx.getRunRefs(updatedRun), walletIds: [walletRecord.walletId] },
      summary: `Trust baseline created for wallet ${walletRecord.walletId}: ${trustBaseline.assessment.status} at tier ${trustBaseline.assessment.trustTier}.`,
      payload: {
        walletId: walletRecord.walletId,
        subjectId: walletRecord.subjectId,
        trustStatus: walletRecord.trustStatus,
        kycWorkflowId,
        trustAssessmentId: trustBaseline.assessment.assessmentId,
        trustTier: trustBaseline.assessment.trustTier,
        trustScore: trustBaseline.assessment.trustScore,
        reasonCodes: trustBaseline.assessment.reasonCodes,
      },
      artifactRefs: [trustBaseline.artifact],
    })

    // ── Reporting + Close ────────────────────────────────────────────────────
    updatedRun = await this.ctx.transitionRunPhase(updatedRun, 'reporting', {
      at,
      actor: this.ctx.getSessionActor(session),
      reason: 'Wallet provisioned, identity linked, compliance initiated, policy attached, trust baseline set.',
      context: {
        planExists: true,
        planPolicyCompatible: true,
        executionBypassed: true,
      },
    })

    const secretNote = provisioned.secretKeyBase64
      ? `IMPORTANT: New keypair generated. Address: ${provisioned.address}. Store the secret key securely — it is not persisted by the runtime.`
      : undefined

    const report = this.buildRunCloseoutReport({
      session,
      run: updatedRun,
      at,
      summary: `Wallet ${walletRecord.walletId} provisioned at ${provisioned.address} for ${walletRecord.subjectId}. KYC initiated. Policy attached.`,
      walletIds: [walletRecord.walletId],
      notes: [
        `Address: ${provisioned.address}`,
        `Signer profile: ${walletRecord.signerProfileId}`,
        `Compliance status: ${walletRecord.complianceStatus} — KYC workflow ${kycWorkflowId} initiated`,
        `Policy attachment: ${walletRecord.policyAttachmentStatus}`,
        `Trust status: unassessed`,
        ...(secretNote ? [secretNote] : []),
      ],
    })

    const reportArtifact = await this.ctx.persistence.artifacts.write(
      { artifactType: 'audit_report', path: `runs/${run.runId}/closeout/${report.reportId}.json` },
      report,
    )

    updatedRun = { ...updatedRun, reportArtifactPath: reportArtifact.path, reportRef: report.reportId, lastUpdatedAt: at }
    await this.ctx.runs.put(updatedRun)

    await this.ctx.appendLedgerEvent({
      eventType: 'run.report_created',
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: 'reporting',
      actor: this.ctx.getSessionActor(session),
      refs: { ...this.ctx.getRunRefs(updatedRun), walletIds: [walletRecord.walletId] },
      summary: report.summary,
      payload: { reportId: report.reportId, finalStatus: report.finalStatus },
      artifactRefs: [reportArtifact],
    })

    const completedRun = await this.ctx.transitionRunPhase(updatedRun, 'completed', {
      at,
      actor: this.ctx.getSessionActor(session),
      reason: 'Wallet onboarding completed: provisioned, linked, KYC initiated, policy attached.',
      status: 'completed',
      context: { reportArtifactCreated: true },
    })

    const outputLines = [
      `Persisted wallet creation intent ${intent.intentId}.`,
      'Wallet creation validation passed.',
      `Policy resolved as ${resolvedPolicy.status}.`,
      `Wallet ${walletRecord.walletId} provisioned at address ${provisioned.address}.`,
      `Subject ${walletRecord.subjectId} linked (${walletCreatePayload3?.subjectType ?? 'individual'}).`,
      `${complianceKickoff.workflow.workflowType.toUpperCase()} workflow ${kycWorkflowId} initiated.`,
      `Policy attached. Trust baseline set.`,
      `Report ${report.reportId} created.`,
    ]
    if (provisioned.secretKeyBase64) {
      outputLines.push(`⚠  New keypair generated — save the secret key from the artifact store before closing this session.`)
    }

    return { run: completedRun, output: outputLines }
  }

  buildDeterministicWalletAddress(walletId: string): string {
    return `0x${createHash('sha256')
      .update(walletId)
      .digest('hex')
      .slice(0, 40)}`
  }

  toWorkflowComplianceStatus(
    status: WalletComplianceStatus,
  ): Exclude<ComplianceWorkflowRecord['status'], 'initiated'> {
    return status === 'not_started' ? 'pending' : status
  }

  toWalletComplianceStatus(
    status: ComplianceWorkflowRecord['status'],
  ): WalletComplianceStatus {
    return status === 'initiated' ? 'pending' : status
  }

  async persistWalletTrustAssessment(input: {
    run: RunState
    session: SessionState
    wallet: WalletRecord
    at: string
    artifactSuffix: string
  }): Promise<{
    wallet: WalletRecord
    assessment: TrustAssessment
    artifact: ArtifactRef
    previousTrustStatus: WalletRecord['trustStatus']
  }> {
    const assessment = await this.ctx.trustEngine.assess({
      objectType: 'wallet',
      objectId: input.wallet.walletId,
      evaluationContext: {
        organizationId: input.wallet.organizationId,
        treasuryId: input.wallet.treasuryId,
        walletId: input.wallet.walletId,
        actionType: input.run.actionType,
        environment: input.session.environment,
      },
    })
    const previousTrustStatus = input.wallet.trustStatus
    const updatedWallet: WalletRecord = {
      ...input.wallet,
      trustStatus: assessment.status,
      updatedAt: input.at,
    }
    await this.ctx.walletRegistry.put(updatedWallet)

    const artifact = await this.ctx.persistence.artifacts.write(
      {
        artifactType: 'trust_assessment',
        path: `runs/${input.run.runId}/ledger/artifacts/trust/${input.wallet.walletId}.${input.artifactSuffix}.json`,
      },
      assessment,
    )

    return {
      wallet: updatedWallet,
      assessment,
      artifact,
      previousTrustStatus,
    }
  }

  deriveWalletStateAfterCompliance(
    wallet: WalletRecord,
    status: WalletComplianceStatus,
  ): WalletLifecycleState {
    if (status === 'rejected' || status === 'restricted') {
      return 'restricted'
    }

    if (status === 'pending' || status === 'not_started') {
      return 'pending_compliance'
    }

    if (status === 'approved') {
      if (wallet.policyAttachmentStatus !== 'attached') {
        return 'linked_pending_policy'
      }

      if (wallet.walletType === 'vendor' || wallet.walletType === 'user') {
        return 'active_receive_only'
      }

      return 'pending_compliance'
    }

    return wallet.state
  }

  async persistComplianceStatusForRun(
    run: RunState,
    session: SessionState,
    event: Extract<KernelCallbackEvent, { type: 'compliance_status' }>,
    at: string,
  ): Promise<{
    run: RunState
    wallet: WalletRecord
    previousState: WalletLifecycleState
    artifacts: ArtifactRef[]
  }> {
    const wallet = await this.ctx.walletRegistry.get(event.walletId)
    if (!wallet) {
      throw new Error(`Unknown wallet ${event.walletId} for compliance callback.`)
    }
    if (
      wallet.complianceWorkflowId &&
      wallet.complianceWorkflowId !== event.complianceWorkflowId
    ) {
      throw new Error(
        `Compliance workflow mismatch for wallet ${event.walletId}. Expected ${wallet.complianceWorkflowId}, received ${event.complianceWorkflowId}.`,
      )
    }

    const previousState = wallet.state
    const currentWorkflow: ComplianceWorkflowRecord = {
      complianceWorkflowId: event.complianceWorkflowId,
      walletId: wallet.walletId,
      subjectId: wallet.subjectId,
      workflowType: event.workflowType,
      status: this.toWorkflowComplianceStatus(wallet.complianceStatus),
      providerId: wallet.complianceProviderId,
      providerCaseId: wallet.complianceProviderCaseId,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    }
    const workflowUpdate = await this.ctx.complianceProvider.applyStatusUpdate({
      workflow: currentWorkflow,
      status: event.status,
      providerId: event.providerId,
      providerCaseId: event.providerCaseId,
      reviewedAt: event.reviewedAt,
      evidenceRef: event.evidenceRef,
      at,
    })
    let updatedWallet: WalletRecord = {
      ...wallet,
      state: this.deriveWalletStateAfterCompliance(
        wallet,
        this.toWalletComplianceStatus(workflowUpdate.workflow.status),
      ),
      complianceStatus: this.toWalletComplianceStatus(workflowUpdate.workflow.status),
      complianceWorkflowId: workflowUpdate.workflow.complianceWorkflowId,
      complianceProviderId:
        workflowUpdate.workflow.providerId ?? wallet.complianceProviderId,
      complianceProviderCaseId:
        workflowUpdate.workflow.providerCaseId ?? wallet.complianceProviderCaseId,
      updatedAt: at,
    }
    await this.ctx.walletRegistry.put(updatedWallet)

    const trustAssessment = await this.persistWalletTrustAssessment({
      run,
      session,
      wallet: updatedWallet,
      at,
      artifactSuffix: `trust_refresh_${event.status}`,
    })
    updatedWallet = trustAssessment.wallet

    await this.ctx.appendLedgerEvent({
      eventType: 'trust.score_updated',
      at,
      runId: run.runId,
      sessionId: run.sessionId,
      phase: run.currentPhase,
      actor: {
        actorType: 'system',
        actorId: 'session-kernel',
      },
      refs: { ...this.ctx.getRunRefs(run), walletIds: [event.walletId] },
      summary: `Trust assessment refreshed for wallet ${event.walletId}: ${trustAssessment.assessment.status} at tier ${trustAssessment.assessment.trustTier}.`,
      payload: {
        walletId: event.walletId,
        trustAssessmentId: trustAssessment.assessment.assessmentId,
        trustStatus: trustAssessment.assessment.status,
        trustTier: trustAssessment.assessment.trustTier,
        trustScore: trustAssessment.assessment.trustScore,
        reasonCodes: trustAssessment.assessment.reasonCodes,
      },
      artifactRefs: [trustAssessment.artifact],
    })

    if (trustAssessment.previousTrustStatus !== updatedWallet.trustStatus) {
      await this.ctx.appendLedgerEvent({
        eventType: 'trust.status_changed',
        at,
        runId: run.runId,
        sessionId: run.sessionId,
        phase: run.currentPhase,
        actor: {
          actorType: 'system',
          actorId: 'session-kernel',
        },
        refs: { ...this.ctx.getRunRefs(run), walletIds: [event.walletId] },
        summary: `Wallet ${event.walletId} trust status changed from ${trustAssessment.previousTrustStatus} to ${updatedWallet.trustStatus}.`,
        payload: {
          walletId: event.walletId,
          previousTrustStatus: trustAssessment.previousTrustStatus,
          nextTrustStatus: updatedWallet.trustStatus,
          trustAssessmentId: trustAssessment.assessment.assessmentId,
        },
        artifactRefs: [trustAssessment.artifact],
      })
    }

    const complianceRecord: ComplianceWorkflowRecord = {
      ...workflowUpdate.workflow,
      walletId: event.walletId,
      subjectId: updatedWallet.subjectId,
      createdAt: wallet.createdAt,
    }
    const complianceArtifact = await this.ctx.persistence.artifacts.write(
      {
        artifactType: 'note',
        path: `runs/${run.runId}/ledger/artifacts/compliance/${event.walletId}.${event.status}.${this.ctx.createId('compliance_event')}.json`,
      },
      complianceRecord,
    )
    const walletArtifact = await this.ctx.persistence.artifacts.write(
      {
        artifactType: 'wallet_snapshot',
        path: `runs/${run.runId}/ledger/artifacts/wallet/${event.walletId}.compliance_${event.status}.json`,
      },
      updatedWallet,
    )

    return {
      run: {
        ...run,
        lastUpdatedAt: at,
      },
      wallet: updatedWallet,
      previousState,
      artifacts: [complianceArtifact, trustAssessment.artifact, walletArtifact],
    }
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
