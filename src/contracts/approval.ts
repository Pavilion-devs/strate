import type {
  ISO8601String,
  IntentRef,
  PolicyProfileRef,
} from './common.js'
import type { ResolvedPolicyProfile } from './policyResolution.js'

export type ApprovalClass =
  | 'none'
  | 'single_human'
  | 'dual_human'
  | 'role_split'
  | 'manual_review_only'
  | 'blocked'

export type ApprovalStatus =
  | 'not_required'
  | 'required'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'invalidated'

export type ApprovalRequirement = {
  requirementId: string
  intentRef: IntentRef
  policyRef: PolicyProfileRef
  reason: string
  requiredRoles?: string[]
  requiredApprovals: number
  roleSeparationRequired?: boolean
  materialHash: string
  createdAt: ISO8601String
  expiresAt?: ISO8601String
}

export type ApprovalRecord = {
  approvalRecordId: string
  requirementId: string
  approver: {
    actorId: string
    role: string
  }
  decision: 'approved' | 'rejected'
  decidedAt: ISO8601String
  comment?: string
  evidenceRef?: string
  intentRef: IntentRef
  materialHash: string
}

export type ApprovalState = {
  approvalStateId: string
  status: ApprovalStatus
  approvalClass: ApprovalClass
  requirement: ApprovalRequirement
  approvals: ApprovalRecord[]
  invalidationReason?: string
  expiresAt?: ISO8601String
}

export type ApprovalEvaluationInput = {
  intentRef: IntentRef
  policy: ResolvedPolicyProfile
  materialHash: string
  computedAt: ISO8601String
}

export type ApprovalDecisionInput = {
  approvalStateId: string
  record: ApprovalRecord
}

export interface ApprovalEngine {
  evaluateRequirement(input: ApprovalEvaluationInput): Promise<ApprovalState>
  recordDecision(input: ApprovalDecisionInput): Promise<ApprovalState>
  invalidate(
    approvalStateId: string,
    reason: string,
    at: ISO8601String,
  ): Promise<ApprovalState>
}
