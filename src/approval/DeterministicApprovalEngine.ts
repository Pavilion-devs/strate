import type {
  ApprovalDecisionInput,
  ApprovalEngine,
  ApprovalEvaluationInput,
  ApprovalRecord,
  ApprovalState,
  ApprovalStatus,
} from '../contracts/approval.js'
import { defaultIdGenerator, defaultNow } from '../runtime/types.js'

type ApprovalEngineDependencies = {
  now?: () => string
  createId?: (prefix: string) => string
}

function isTerminalStatus(status: ApprovalStatus): boolean {
  return (
    status === 'approved' ||
    status === 'rejected' ||
    status === 'expired' ||
    status === 'invalidated'
  )
}

function countApprovedRecords(approvals: ApprovalRecord[]): ApprovalRecord[] {
  return approvals.filter((record) => record.decision === 'approved')
}

function hasRejectedRecord(approvals: ApprovalRecord[]): boolean {
  return approvals.some((record) => record.decision === 'rejected')
}

function hasRoleSeparation(
  approvals: ApprovalRecord[],
  requiredApprovals: number,
): boolean {
  const uniqueRoles = new Set(approvals.map((approval) => approval.approver.role))
  return uniqueRoles.size >= requiredApprovals
}

function hasRequiredRoles(
  approvals: ApprovalRecord[],
  requiredRoles: string[] | undefined,
): boolean {
  if (!requiredRoles || requiredRoles.length === 0) {
    return true
  }

  return requiredRoles.every((requiredRole) =>
    approvals.some((approval) => approval.approver.role === requiredRole),
  )
}

function toEpochMillis(value: string | undefined): number | undefined {
  if (!value) {
    return undefined
  }

  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function isExpired(expiresAt: string | undefined, at: string): boolean {
  const expiresAtMillis = toEpochMillis(expiresAt)
  const atMillis = toEpochMillis(at)
  if (expiresAtMillis == null || atMillis == null) {
    return false
  }

  return atMillis >= expiresAtMillis
}

export class DeterministicApprovalEngine implements ApprovalEngine {
  private readonly states = new Map<string, ApprovalState>()
  private readonly now: () => string
  private readonly createId: (prefix: string) => string

  constructor(dependencies: ApprovalEngineDependencies = {}) {
    this.now = dependencies.now ?? defaultNow
    this.createId = dependencies.createId ?? defaultIdGenerator
  }

  async evaluateRequirement(
    input: ApprovalEvaluationInput,
  ): Promise<ApprovalState> {
    const approvalStateId = this.createId('approval_state')
    const requirementId = this.createId('approval_requirement')
    const approvalClass = input.policy.approvals.approvalClass

    const state: ApprovalState = {
      approvalStateId,
      status:
        approvalClass === 'none'
          ? 'not_required'
          : approvalClass === 'blocked'
            ? 'rejected'
            : 'pending',
      approvalClass,
      requirement: {
        requirementId,
        intentRef: input.intentRef,
        policyRef: {
          policyProfileId:
            input.policy.sourceProfiles[0]?.policyProfileId ?? 'resolved_policy',
          version: input.policy.sourceProfiles[0]?.version ?? 'resolved',
        },
        reason: input.policy.approvals.reason,
        requiredRoles: input.policy.approvals.requiredRoles,
        requiredApprovals: input.policy.approvals.requiredApprovals,
        roleSeparationRequired: input.policy.approvals.roleSeparationRequired,
        materialHash: input.materialHash,
        createdAt: input.computedAt,
        expiresAt: input.policy.approvals.expiresAt,
      },
      approvals: [],
      invalidationReason:
        approvalClass === 'blocked'
          ? 'Approval class is blocked by resolved policy.'
          : undefined,
      expiresAt: input.policy.approvals.expiresAt,
    }

    this.states.set(state.approvalStateId, state)
    return state
  }

  async recordDecision(input: ApprovalDecisionInput): Promise<ApprovalState> {
    const state = this.states.get(input.approvalStateId)
    if (!state) {
      throw new Error(`Unknown approval state: ${input.approvalStateId}`)
    }

    if (isTerminalStatus(state.status)) {
      throw new Error(
        `Cannot record a decision on terminal approval state ${state.approvalStateId}.`,
      )
    }

    if (input.record.requirementId !== state.requirement.requirementId) {
      throw new Error('Approval record requirement id does not match state.')
    }

    if (input.record.materialHash !== state.requirement.materialHash) {
      throw new Error('Approval material hash mismatch.')
    }

    const expiryAt = state.expiresAt ?? state.requirement.expiresAt
    if (isExpired(expiryAt, input.record.decidedAt)) {
      const expiredState: ApprovalState = {
        ...state,
        status: 'expired',
        invalidationReason: `expired @ ${input.record.decidedAt}`,
      }
      this.states.set(expiredState.approvalStateId, expiredState)
      return expiredState
    }

    if (
      input.record.decision === 'approved' &&
      state.requirement.requiredRoles &&
      state.requirement.requiredRoles.length > 0 &&
      !state.requirement.requiredRoles.includes(input.record.approver.role)
    ) {
      throw new Error(
        `Approver role ${input.record.approver.role} is not allowed for this approval requirement.`,
      )
    }

    if (
      state.approvals.some(
        (existingApproval) =>
          existingApproval.approver.actorId === input.record.approver.actorId,
      )
    ) {
      throw new Error(
        `Approver ${input.record.approver.actorId} has already submitted a decision.`,
      )
    }

    const approvals = [...state.approvals, input.record]
    const approvedRecords = countApprovedRecords(approvals)

    let status: ApprovalStatus = 'pending'
    if (hasRejectedRecord(approvals)) {
      status = 'rejected'
    } else if (
      approvedRecords.length >= state.requirement.requiredApprovals &&
      hasRequiredRoles(approvedRecords, state.requirement.requiredRoles) &&
      (!state.requirement.roleSeparationRequired ||
        hasRoleSeparation(approvedRecords, state.requirement.requiredApprovals))
    ) {
      status = 'approved'
    }

    const updatedState: ApprovalState = {
      ...state,
      approvals,
      status,
    }

    this.states.set(updatedState.approvalStateId, updatedState)
    return updatedState
  }

  async invalidate(
    approvalStateId: string,
    reason: string,
    at: string = this.now(),
  ): Promise<ApprovalState> {
    const state = this.states.get(approvalStateId)
    if (!state) {
      throw new Error(`Unknown approval state: ${approvalStateId}`)
    }

    const updatedState: ApprovalState = {
      ...state,
      status: 'invalidated',
      invalidationReason: `${reason} @ ${at}`,
    }

    this.states.set(updatedState.approvalStateId, updatedState)
    return updatedState
  }
}
