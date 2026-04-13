import type { ApprovalRecord, ApprovalState } from '../../contracts/approval.js'
import type { ApprovalReviewPackage } from '../../contracts/approvalReview.js'
import type { ArtifactRef } from '../../contracts/ledger.js'
import type { ResolvedPolicyProfile } from '../../contracts/policyResolution.js'
import type { SimulationRecord } from '../../contracts/simulation.js'
import type { IntentObject } from '../../contracts/intent.js'
import type {
  RunState,
} from '../../contracts/runtime.js'
import type { PhaseHandlerContext } from './PhaseHandlerContext.js'
import { isTerminalApprovalStatus, isTimestampExpired } from './phaseUtils.js'

export class ApprovalPackageHandler {
  constructor(private readonly ctx: PhaseHandlerContext) {}

  buildApprovalReviewPackage(input: {
    intent: IntentObject
    resolvedPolicy: ResolvedPolicyProfile
    approvalState: ApprovalState
    simulation?: SimulationRecord
  }): ApprovalReviewPackage {
    const { intent, resolvedPolicy, approvalState, simulation } = input

    let sourceLabel: string | undefined
    let destinationLabel: string | undefined
    let chain: string | undefined
    let asset: string | undefined
    let amount: string | undefined

    if (intent.action.type === 'asset.transfer') {
      sourceLabel = intent.action.payload.sourceWalletId
      destinationLabel = intent.action.payload.destinationAddress
      chain = intent.action.payload.chainId
      asset = intent.action.payload.assetSymbol
      amount = intent.action.payload.amount
    } else if (intent.action.type === 'treasury.rebalance') {
      sourceLabel = intent.action.payload.sourceWalletId
      destinationLabel = intent.action.payload.destinationWalletId
      chain = intent.action.payload.chainId
      asset = intent.action.payload.assetSymbol
      amount = intent.action.payload.targetAmount
    } else if (intent.action.type === 'treasury.payment_batch') {
      sourceLabel = intent.action.payload.sourceWalletId
      destinationLabel = `${intent.action.payload.payments.length} recipients`
      chain = intent.action.payload.chainId
      asset = intent.action.payload.assetSymbol
      amount = intent.action.payload.payments
        .reduce((sum, payment) => sum + Number(payment.amount), 0)
        .toString()
    }

    const actionTitle =
      intent.action.type === 'asset.transfer'
        ? 'Asset Transfer Approval'
        : intent.action.type === 'treasury.rebalance'
          ? 'Treasury Rebalance Approval'
          : intent.action.type === 'treasury.payment_batch'
            ? 'Treasury Payment Batch Approval'
            : `${intent.action.type} Approval`
    const failedInvariants = simulation?.invariants.filter(
      (invariant) => invariant.status === 'failed',
    )
    const sourceProfile = resolvedPolicy.sourceProfiles[0]
    const signerClass =
      resolvedPolicy.signing.requiredSignerClass ??
      resolvedPolicy.signing.allowedSignerClasses[0]

    return {
      requirementId: approvalState.requirement.requirementId,
      approvalStateId: approvalState.approvalStateId,
      status: approvalState.status,
      approvalClass: approvalState.approvalClass,
      actionSummary: {
        actionType: intent.action.type,
        title: actionTitle,
        humanSummary: intent.explanation.normalizedSummary,
        effectStatement: intent.explanation.effectStatement,
      },
      intentRef: approvalState.requirement.intentRef,
      policyRef: {
        resolutionId: resolvedPolicy.resolutionId,
        policyProfileId: sourceProfile?.policyProfileId,
        version: sourceProfile?.version,
      },
      materialView: {
        materialHash: approvalState.requirement.materialHash,
        sourceLabel,
        destinationLabel,
        chain,
        asset,
        amount,
        signerClass,
        routeSummary:
          simulation != null
            ? `${simulation.expectedAssetDeltas.length} expected asset deltas`
            : undefined,
        payloadHash: simulation?.resultHash,
      },
      simulationView:
        simulation != null
          ? {
              simulationId: simulation.simulationId,
              status: simulation.status,
              simulatedAt: simulation.simulatedAt,
              freshnessExpiresAt: simulation.freshnessExpiresAt,
              expectedAssetDeltas: simulation.expectedAssetDeltas,
              failedInvariants,
            }
          : undefined,
      trustView: {
        minimumCounterpartyTrustTier:
          resolvedPolicy.trust.minimumCounterpartyTrustTier,
        minimumWalletTrustTier: resolvedPolicy.trust.minimumWalletTrustTier,
        counterpartyStatus: resolvedPolicy.trust.counterpartyStatus,
        walletStatus: resolvedPolicy.trust.walletStatus,
        routeStatus: resolvedPolicy.trust.routeStatus,
        manualReviewRequired: resolvedPolicy.trust.manualReviewRequired,
      },
      roleRequirements: {
        requiredApprovals: approvalState.requirement.requiredApprovals,
        requiredRoles: approvalState.requirement.requiredRoles,
        roleSeparationRequired: approvalState.requirement.roleSeparationRequired,
      },
      timing: {
        createdAt: approvalState.requirement.createdAt,
        expiresAt: approvalState.expiresAt ?? approvalState.requirement.expiresAt,
      },
      reasonCodes: resolvedPolicy.reasonCodes,
    }
  }

  async writeApprovalReviewPackageArtifact(
    run: RunState,
    approvalState: ApprovalState,
    at: string,
  ): Promise<{
    run: RunState
    artifact: ArtifactRef
    reviewPackage: ApprovalReviewPackage
  } | undefined> {
    const intent = await this.ctx.readArtifactJson<IntentObject>(run.intentArtifactPath)
    const resolvedPolicy = await this.ctx.readArtifactJson<ResolvedPolicyProfile>(
      run.policyArtifactPath,
    )
    if (!intent || !resolvedPolicy) {
      return undefined
    }

    const simulation = await this.ctx.readArtifactJson<SimulationRecord>(
      run.simulationArtifactPaths.at(-1),
    )
    const reviewPackage = this.buildApprovalReviewPackage({
      intent,
      resolvedPolicy,
      approvalState,
      simulation,
    })
    const reviewArtifact = await this.ctx.persistence.artifacts.write(
      {
        artifactType: 'approval_review_package',
        path: `runs/${run.runId}/ledger/artifacts/approval-review/${approvalState.approvalStateId}.${approvalState.status}.${this.ctx.createId('approval_review')}.json`,
      },
      reviewPackage,
    )
    const updatedRun: RunState = {
      ...run,
      approvalReviewArtifactPath: reviewArtifact.path,
      lastUpdatedAt: at,
    }
    await this.ctx.runs.put(updatedRun)

    return {
      run: updatedRun,
      artifact: reviewArtifact,
      reviewPackage,
    }
  }

  async persistApprovalDecisionForRun(
    run: RunState,
    status: 'approved' | 'rejected' | 'expired' | 'invalidated',
    approvalStateRef: string | undefined,
    approvalRecord:
      | {
          approvalRecordId?: string
          approver: {
            actorId: string
            role: string
          }
          comment?: string
          evidenceRef?: string
          decidedAt?: string
        }
      | undefined,
    submission:
      | {
          requirementId?: string
          viewedMaterialHash?: string
          viewedAt?: string
          breakGlassReason?: string
        }
      | undefined,
    at: string,
  ): Promise<{
    run: RunState
    approvalState: ApprovalState
    artifact: ArtifactRef
  }> {
    const currentApprovalState = await this.ctx.readArtifactJson<ApprovalState>(
      run.approvalArtifactPath,
    )
    const resolvedApprovalStateRef =
      approvalStateRef ?? run.approvalStateRef ?? this.ctx.createId('approval_state')

    const baseApprovalState: ApprovalState = currentApprovalState
      ? {
          ...currentApprovalState,
          approvalStateId: resolvedApprovalStateRef,
          invalidationReason: undefined,
        }
      : {
          approvalStateId: resolvedApprovalStateRef,
          status: 'pending',
          approvalClass: status === 'approved' ? 'single_human' : 'blocked',
          requirement: {
            requirementId: this.ctx.createId('approval_requirement'),
            intentRef:
              run.intentRef ?? {
                intentId: 'unknown_intent',
                version: 'unknown',
              },
            policyRef: {
              policyProfileId: 'callback_approval',
              version: 'v1',
            },
            reason: 'Approval callback supplied decision state.',
            requiredApprovals: 1,
            materialHash: 'callback_material_hash',
            createdAt: at,
          },
          approvals: [],
        }

    if (
      (status === 'approved' || status === 'rejected') &&
      isTerminalApprovalStatus(baseApprovalState.status)
    ) {
      throw new Error(
        `Approval state ${resolvedApprovalStateRef} is already terminal (${baseApprovalState.status}).`,
      )
    }

    let updatedApprovalState: ApprovalState = baseApprovalState
    const approvalExpiry =
      baseApprovalState.expiresAt ?? baseApprovalState.requirement.expiresAt
    const breakGlassReason = submission?.breakGlassReason?.trim()
    const breakGlassRequested =
      status === 'approved' && breakGlassReason != null && breakGlassReason.length > 0

    if (
      submission?.requirementId &&
      submission.requirementId !== baseApprovalState.requirement.requirementId
    ) {
      throw new Error(
        `Approval requirement mismatch for state ${resolvedApprovalStateRef}.`,
      )
    }

    if (
      submission?.viewedMaterialHash &&
      submission.viewedMaterialHash !== baseApprovalState.requirement.materialHash
    ) {
      throw new Error(
        `Approval material hash mismatch for state ${resolvedApprovalStateRef}.`,
      )
    }

    if (submission?.viewedAt && isTimestampExpired(approvalExpiry, submission.viewedAt)) {
      throw new Error(
        `Approval view is stale for state ${resolvedApprovalStateRef}; refresh approval package before deciding.`,
      )
    }

    if (isTimestampExpired(approvalExpiry, at)) {
      updatedApprovalState = {
        ...baseApprovalState,
        status: 'expired',
        invalidationReason: `expired @ ${at}`,
      }
    } else if (status === 'approved' || status === 'rejected') {
      const approverRole = approvalRecord?.approver.role ?? 'unknown'
      const approverActorId = approvalRecord?.approver.actorId
      const requiredRoles = baseApprovalState.requirement.requiredRoles ?? []
      if (
        approverActorId &&
        baseApprovalState.approvals.some(
          (existingRecord) =>
            existingRecord.approver.actorId === approverActorId,
        )
      ) {
        throw new Error(
          `Approver ${approverActorId} already submitted a decision for state ${resolvedApprovalStateRef}.`,
        )
      }

      if (
        status === 'approved' &&
        !breakGlassRequested &&
        requiredRoles.length > 0 &&
        !requiredRoles.includes(approverRole)
      ) {
        throw new Error(
          `Approver role ${approverRole} is not eligible for approval state ${resolvedApprovalStateRef}. Required roles: ${requiredRoles.join(', ')}.`,
        )
      }

      if (breakGlassRequested) {
        const resolvedPolicy = await this.ctx.readArtifactJson<ResolvedPolicyProfile>(
          run.policyArtifactPath,
        )
        const breakGlassRoles = resolvedPolicy?.emergency.breakGlassRoles ?? []
        if (breakGlassRoles.length === 0) {
          throw new Error(
            `Break-glass is not enabled for run ${run.runId}.`,
          )
        }
        if (!breakGlassRoles.includes(approverRole)) {
          throw new Error(
            `Approver role ${approverRole} is not authorized for break-glass on run ${run.runId}.`,
          )
        }
      }

      const record: ApprovalRecord = {
        approvalRecordId:
          approvalRecord?.approvalRecordId ?? this.ctx.createId('approval_record'),
        requirementId: baseApprovalState.requirement.requirementId,
        approver: approvalRecord?.approver ?? {
          actorId: 'callback_approver',
          role: 'unknown',
        },
        decision: status,
        decidedAt: approvalRecord?.decidedAt ?? at,
        comment:
          breakGlassRequested
            ? `[break-glass] ${breakGlassReason}${approvalRecord?.comment ? ` | ${approvalRecord.comment}` : ''}`
            : approvalRecord?.comment,
        evidenceRef: approvalRecord?.evidenceRef,
        intentRef: baseApprovalState.requirement.intentRef,
        materialHash: baseApprovalState.requirement.materialHash,
      }

      const approvals = [
        ...baseApprovalState.approvals,
        record,
      ]

      const approvedRecords = approvals.filter(
        (existingRecord) => existingRecord.decision === 'approved',
      )
      const uniqueRoles = new Set(
        approvedRecords.map((existingRecord) => existingRecord.approver.role),
      )
      const requiredRolesSatisfied =
        requiredRoles.length === 0 ||
        requiredRoles.every((requiredRole) =>
          approvedRecords.some(
            (existingRecord) => existingRecord.approver.role === requiredRole,
          ),
        )
      const roleSeparationSatisfied =
        !baseApprovalState.requirement.roleSeparationRequired ||
        uniqueRoles.size >= baseApprovalState.requirement.requiredApprovals

      updatedApprovalState = {
        ...baseApprovalState,
        approvals,
        status: breakGlassRequested
          ? 'approved'
          : approvals.some((existingRecord) => existingRecord.decision === 'rejected')
            ? 'rejected'
            : approvedRecords.length >= baseApprovalState.requirement.requiredApprovals &&
                roleSeparationSatisfied &&
                requiredRolesSatisfied
              ? 'approved'
              : 'pending',
      }
    } else {
      updatedApprovalState = {
        ...baseApprovalState,
        status,
        invalidationReason: `${status} @ ${at}`,
      }
    }

    const approvalArtifact = await this.ctx.persistence.artifacts.write(
      {
        artifactType: 'approval_record',
        path: `runs/${run.runId}/ledger/artifacts/approvals/${resolvedApprovalStateRef}.${updatedApprovalState.status}.${this.ctx.createId('approval_event')}.json`,
      },
      updatedApprovalState,
    )

    const updatedRun: RunState = {
      ...run,
      approvalStateRef: resolvedApprovalStateRef,
      approvalArtifactPath: approvalArtifact.path,
      status:
        updatedApprovalState.status === 'approved'
          ? 'active'
          : updatedApprovalState.status === 'pending'
            ? 'waiting_for_approval'
            : 'failed',
      lastUpdatedAt: at,
    }

    await this.ctx.runs.put(updatedRun)
    let finalRun = updatedRun
    const approvalReview = await this.writeApprovalReviewPackageArtifact(
      updatedRun,
      updatedApprovalState,
      at,
    )
    if (approvalReview) {
      finalRun = approvalReview.run
    }
    return {
      run: finalRun,
      approvalState: updatedApprovalState,
      artifact: approvalArtifact,
    }
  }
}
