import type { ISO8601String } from './common.js'
import type { ApprovalState } from './approval.js'
import type { ApprovalReviewPackage } from './approvalReview.js'
import type { RunState } from './runtime.js'

export type ApprovalDecisionActor = {
  actorId: string
  roleId: string
}

export type ApprovalDecisionSubmission = {
  runId: string
  actor: ApprovalDecisionActor
  decision: 'approved' | 'rejected'
  approvalStateId?: string
  requirementId?: string
  comment?: string
  viewedMaterialHash?: string
  viewedAt?: ISO8601String
  decidedAt?: ISO8601String
  breakGlassReason?: string
  externalEvidenceRef?: string
}

export type ApprovalSubmissionOutcome =
  | 'accepted'
  | 'rejected_ineligible'
  | 'rejected_stale'
  | 'rejected_expired'
  | 'rejected_duplicate'
  | 'rejected_conflict'

export type ApprovalReviewEnvelope = {
  run: RunState
  approvalStateRef?: string
  artifactPath: string
  reviewPackage: ApprovalReviewPackage
}

export type ApprovalSubmissionResult = {
  outcome: ApprovalSubmissionOutcome
  run: RunState
  approvalState?: ApprovalState
  reviewPackage?: ApprovalReviewPackage
  message: string
}

export interface ExternalApprovalClient {
  listPendingReviews(sessionId: string): Promise<ApprovalReviewEnvelope[]>
  getReviewPackage(runId: string): Promise<ApprovalReviewEnvelope>
  submitDecision(
    input: ApprovalDecisionSubmission,
  ): Promise<ApprovalSubmissionResult>
}
