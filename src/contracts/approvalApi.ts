import type { ISO8601String, RuntimeActor } from './common.js'
import type {
  ApprovalDecisionSubmission,
  ApprovalReviewEnvelope,
  ApprovalSubmissionResult,
} from './approvalClient.js'

export type ApprovalApiSurface =
  | 'external_api'
  | 'dashboard'
  | 'automation'
  | 'backoffice'

export type ListPendingApprovalReviewsRequest = {
  sessionId: string
  limit?: number
}

export type ListPendingApprovalReviewsResponse = {
  reviews: ApprovalReviewEnvelope[]
}

export type GetApprovalReviewRequest = {
  runId: string
  viewer: RuntimeActor
  surface?: ApprovalApiSurface
  requestedAt?: ISO8601String
}

export type GetApprovalReviewResponse = {
  review: ApprovalReviewEnvelope
  renderedAt: ISO8601String
}

export type SubmitApprovalDecisionRequest = ApprovalDecisionSubmission & {
  surface?: ApprovalApiSurface
  receivedAt?: ISO8601String
}

export type SubmitApprovalDecisionResponse = ApprovalSubmissionResult & {
  receivedAt: ISO8601String
}

export interface ApprovalApiService {
  listPendingReviews(
    request: ListPendingApprovalReviewsRequest,
  ): Promise<ListPendingApprovalReviewsResponse>
  getApprovalReview(
    request: GetApprovalReviewRequest,
  ): Promise<GetApprovalReviewResponse>
  submitApprovalDecision(
    request: SubmitApprovalDecisionRequest,
  ): Promise<SubmitApprovalDecisionResponse>
}
