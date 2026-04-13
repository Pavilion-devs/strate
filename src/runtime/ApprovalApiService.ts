import type {
  ApprovalApiService as ApprovalApiServiceContract,
  GetApprovalReviewRequest,
  GetApprovalReviewResponse,
  ListPendingApprovalReviewsRequest,
  ListPendingApprovalReviewsResponse,
  SubmitApprovalDecisionRequest,
  SubmitApprovalDecisionResponse,
} from '../contracts/approvalApi.js'
import type { ExternalApprovalClient } from '../contracts/approvalClient.js'
import type { LedgerEvent, LedgerRefs, ExecutionLedger } from '../contracts/ledger.js'
import type { RunState } from '../contracts/runtime.js'
import { defaultIdGenerator, defaultNow } from './types.js'

type ApprovalApiServiceDependencies = {
  client: ExternalApprovalClient
  ledger: ExecutionLedger
  now?: () => string
  createId?: (prefix: string) => string
}

export class RuntimeApprovalApiService implements ApprovalApiServiceContract {
  private readonly client: ExternalApprovalClient
  private readonly ledger: ExecutionLedger
  private readonly now: () => string
  private readonly createId: (prefix: string) => string

  constructor(dependencies: ApprovalApiServiceDependencies) {
    this.client = dependencies.client
    this.ledger = dependencies.ledger
    this.now = dependencies.now ?? defaultNow
    this.createId = dependencies.createId ?? defaultIdGenerator
  }

  async listPendingReviews(
    request: ListPendingApprovalReviewsRequest,
  ): Promise<ListPendingApprovalReviewsResponse> {
    const reviews = await this.client.listPendingReviews(request.sessionId)
    const limit = request.limit ?? 25

    return {
      reviews: reviews
        .sort((left, right) =>
          right.run.lastUpdatedAt.localeCompare(left.run.lastUpdatedAt),
        )
        .slice(0, limit),
    }
  }

  async getApprovalReview(
    request: GetApprovalReviewRequest,
  ): Promise<GetApprovalReviewResponse> {
    const renderedAt = request.requestedAt ?? this.now()
    const review = await this.client.getReviewPackage(request.runId)

    await this.appendLedgerEvent({
      eventType: 'approval.request_rendered',
      at: renderedAt,
      run: review.run,
      actor: request.viewer,
      summary: `Approval review package rendered for run ${request.runId}.`,
      payload: {
        approvalStateId: review.reviewPackage.approvalStateId,
        requirementId: review.reviewPackage.requirementId,
        artifactPath: review.artifactPath,
        surface: request.surface ?? 'external_api',
      },
      redactionLevel: 'restricted',
    })

    return {
      review,
      renderedAt,
    }
  }

  async submitApprovalDecision(
    request: SubmitApprovalDecisionRequest,
  ): Promise<SubmitApprovalDecisionResponse> {
    const receivedAt = request.receivedAt ?? this.now()
    const review = await this.client.getReviewPackage(request.runId)

    await this.appendLedgerEvent({
      eventType: 'approval.submission_received',
      at: receivedAt,
      run: review.run,
      actor: {
        actorType: 'human',
        actorId: request.actor.actorId,
        role: request.actor.roleId,
      },
      summary: `Approval decision submission received for run ${request.runId}.`,
      payload: {
        approvalStateId:
          request.approvalStateId ?? review.reviewPackage.approvalStateId,
        requirementId: request.requirementId ?? review.reviewPackage.requirementId,
        decision: request.decision,
        surface: request.surface ?? 'external_api',
        viewedAt: request.viewedAt ?? receivedAt,
        viewedMaterialHash:
          request.viewedMaterialHash ?? review.reviewPackage.materialView.materialHash,
        breakGlassReason: request.breakGlassReason,
        externalEvidenceRef: request.externalEvidenceRef,
      },
      redactionLevel: 'restricted',
    })

    const result = await this.client.submitDecision({
      ...request,
      viewedAt: request.viewedAt ?? receivedAt,
      decidedAt: request.decidedAt ?? receivedAt,
    })

    return {
      ...result,
      receivedAt,
    }
  }

  private async appendLedgerEvent(input: {
    eventType: string
    at: string
    run: RunState
    actor: LedgerEvent['actor']
    summary: string
    payload: Record<string, unknown>
    redactionLevel?: LedgerEvent['redactionLevel']
  }): Promise<void> {
    await this.ledger.append({
      eventId: this.createId('event'),
      eventType: input.eventType,
      at: input.at,
      sessionId: input.run.sessionId,
      runId: input.run.runId,
      phase: input.run.currentPhase,
      actor: input.actor,
      refs: this.getRunRefs(input.run),
      summary: input.summary,
      payload: input.payload,
      redactionLevel: input.redactionLevel,
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
}
