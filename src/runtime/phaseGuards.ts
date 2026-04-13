import type { ApprovalStatus } from '../contracts/approval.js'
import type { RuntimePhase } from '../contracts/runtime.js'

export type PhaseTransitionContext = {
  activeRunContext?: boolean
  actorIdentityResolved?: boolean
  intentExists?: boolean
  intentPersisted?: boolean
  validationPassed?: boolean
  resolvedPolicyExists?: boolean
  actionAllowedToBePlanned?: boolean
  planExists?: boolean
  planPolicyCompatible?: boolean
  executionBypassed?: boolean
  simulationRequired?: boolean
  simulationCompleted?: boolean
  simulationFreshnessRecorded?: boolean
  approvalStatus?: ApprovalStatus
  approvalInvalidated?: boolean
  emergencyHaltActive?: boolean
  signatureResultExists?: boolean
  signatureValidForPlannedPayload?: boolean
  broadcastHandleExists?: boolean
  finalObservedResultClassified?: boolean
  reportArtifactCreated?: boolean
}

export type PhaseTransitionDecision = {
  allowed: boolean
  reasonCode: string
  explanation: string
}

const ALLOWED_FORWARD_TRANSITIONS: Record<RuntimePhase, RuntimePhase[]> = {
  session_setup: ['intent_capture', 'failed', 'halted'],
  intent_capture: ['validation', 'failed', 'halted'],
  validation: ['policy_resolution', 'failed', 'halted'],
  policy_resolution: ['planning', 'failed', 'halted'],
  planning: ['simulation', 'reporting', 'failed', 'halted'],
  simulation: ['approval', 'failed', 'halted'],
  approval: ['signing', 'failed', 'halted'],
  signing: ['broadcast', 'failed', 'halted'],
  broadcast: ['reconciliation', 'failed', 'halted'],
  reconciliation: ['reporting', 'failed', 'halted'],
  reporting: ['completed', 'failed', 'halted'],
  completed: [],
  failed: [],
  halted: [],
}

function allow(
  reasonCode: string,
  explanation: string,
): PhaseTransitionDecision {
  return {
    allowed: true,
    reasonCode,
    explanation,
  }
}

function deny(
  reasonCode: string,
  explanation: string,
): PhaseTransitionDecision {
  return {
    allowed: false,
    reasonCode,
    explanation,
  }
}

function isTerminalPhase(phase: RuntimePhase): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'halted'
}

export function canTransitionPhase(
  from: RuntimePhase,
  to: RuntimePhase,
  context: PhaseTransitionContext,
): PhaseTransitionDecision {
  if (from === to) {
    return allow('phase.noop', `Run is already in ${to}.`)
  }

  if (to === 'halted' && !isTerminalPhase(from)) {
    return allow('phase.halt_allowed', 'Emergency halt is allowed from any active phase.')
  }

  if (to === 'failed' && !isTerminalPhase(from)) {
    return allow('phase.fail_allowed', 'Failure is allowed from any active phase.')
  }

  if (!ALLOWED_FORWARD_TRANSITIONS[from].includes(to)) {
    return deny(
      'phase.transition_not_allowed',
      `Transition from ${from} to ${to} is not allowed.`,
    )
  }

  switch (`${from}->${to}`) {
    case 'session_setup->intent_capture':
      if (!context.activeRunContext) {
        return deny(
          'phase.missing_run_context',
          'Cannot enter intent capture without an active run context.',
        )
      }
      if (!context.actorIdentityResolved) {
        return deny(
          'phase.actor_unresolved',
          'Cannot enter intent capture before actor identity is resolved.',
        )
      }
      return allow(
        'phase.ready_for_intent_capture',
        'Run may proceed into intent capture.',
      )
    case 'intent_capture->validation':
      if (!context.intentExists || !context.intentPersisted) {
        return deny(
          'phase.intent_missing',
          'Validation requires a persisted intent object.',
        )
      }
      return allow(
        'phase.intent_ready_for_validation',
        'Intent exists and is persisted.',
      )
    case 'validation->policy_resolution':
      if (!context.validationPassed) {
        return deny(
          'phase.validation_failed',
          'Policy resolution requires successful validation.',
        )
      }
      return allow(
        'phase.validation_passed',
        'Validation passed and policy resolution may proceed.',
      )
    case 'policy_resolution->planning':
      if (!context.resolvedPolicyExists) {
        return deny(
          'phase.policy_missing',
          'Planning requires a resolved policy profile.',
        )
      }
      if (!context.actionAllowedToBePlanned) {
        return deny(
          'phase.action_not_plannable',
          'The resolved policy does not allow planning for this action.',
        )
      }
      return allow(
        'phase.policy_ready_for_planning',
        'Resolved policy allows planning.',
      )
    case 'planning->simulation':
      if (!context.planExists) {
        return deny('phase.plan_missing', 'Simulation requires a plan.')
      }
      if (!context.planPolicyCompatible) {
        return deny(
          'phase.plan_not_policy_compatible',
          'Simulation requires a policy-compatible plan.',
        )
      }
      return allow(
        'phase.plan_ready_for_simulation',
        'Plan exists and is policy-compatible.',
      )
    case 'planning->reporting':
      if (!context.planExists) {
        return deny('phase.plan_missing', 'Reporting requires a completed plan.')
      }
      if (!context.planPolicyCompatible) {
        return deny(
          'phase.plan_not_policy_compatible',
          'Reporting requires a policy-compatible plan.',
        )
      }
      if (!context.executionBypassed) {
        return deny(
          'phase.execution_not_bypassed',
          'Direct reporting from planning requires a runtime-completed plan.',
        )
      }
      return allow(
        'phase.plan_ready_for_reporting',
        'Plan completed inside the runtime and may proceed directly to reporting.',
      )
    case 'simulation->approval':
      if (context.simulationRequired && !context.simulationCompleted) {
        return deny(
          'phase.simulation_missing',
          'Approval cannot proceed without a required simulation result.',
        )
      }
      if (context.simulationRequired && !context.simulationFreshnessRecorded) {
        return deny(
          'phase.simulation_freshness_missing',
          'Approval requires a recorded simulation freshness window.',
        )
      }
      return allow(
        'phase.simulation_ready_for_approval',
        'Simulation requirements are satisfied.',
      )
    case 'approval->signing':
      if (
        context.approvalStatus !== 'approved' &&
        context.approvalStatus !== 'not_required'
      ) {
        return deny(
          'phase.approval_missing',
          'Signing requires approval to be approved or not required.',
        )
      }
      if (context.approvalInvalidated) {
        return deny(
          'phase.approval_invalidated',
          'Signing cannot proceed with invalidated approval state.',
        )
      }
      if (context.emergencyHaltActive) {
        return deny(
          'phase.emergency_halt_active',
          'Signing cannot proceed during an emergency halt.',
        )
      }
      return allow(
        'phase.approval_ready_for_signing',
        'Approval state allows signing.',
      )
    case 'signing->broadcast':
      if (!context.signatureResultExists) {
        return deny(
          'phase.signature_missing',
          'Broadcast requires a signature result.',
        )
      }
      if (!context.signatureValidForPlannedPayload) {
        return deny(
          'phase.signature_payload_mismatch',
          'Broadcast requires a signature valid for the planned payload.',
        )
      }
      return allow(
        'phase.signature_ready_for_broadcast',
        'Signature result is valid for broadcast.',
      )
    case 'broadcast->reconciliation':
      if (!context.broadcastHandleExists) {
        return deny(
          'phase.broadcast_handle_missing',
          'Reconciliation requires a submission handle or transaction hash.',
        )
      }
      return allow(
        'phase.broadcast_ready_for_reconciliation',
        'Broadcast result is ready for reconciliation.',
      )
    case 'reconciliation->reporting':
      if (!context.finalObservedResultClassified) {
        return deny(
          'phase.reconciliation_incomplete',
          'Reporting requires a classified final observed result.',
        )
      }
      return allow(
        'phase.reconciliation_ready_for_reporting',
        'Reconciliation completed and reporting may proceed.',
      )
    case 'reporting->completed':
      if (!context.reportArtifactCreated) {
        return deny(
          'phase.report_missing',
          'Completion requires a final report artifact.',
        )
      }
      return allow(
        'phase.report_ready_for_completion',
        'Final report exists and the run may complete.',
      )
    default:
      return allow(
        'phase.transition_allowed',
        `Transition from ${from} to ${to} is allowed.`,
      )
  }
}

export function assertPhaseTransition(
  from: RuntimePhase,
  to: RuntimePhase,
  context: PhaseTransitionContext,
): void {
  const decision = canTransitionPhase(from, to, context)
  if (!decision.allowed) {
    throw new Error(`${decision.reasonCode}: ${decision.explanation}`)
  }
}
