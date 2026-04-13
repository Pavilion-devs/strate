import type {
  ISO8601String,
  RuntimeEnvironment,
  RuntimeActor,
} from './common.js'
import type { IntentActionType } from './intent.js'
import type { SignatureResultStatus } from './signing.js'
import type { ComplianceWorkflowType, ComplianceWorkflowStatus } from './compliance.js'

export type RuntimePhase =
  | 'session_setup'
  | 'intent_capture'
  | 'validation'
  | 'policy_resolution'
  | 'planning'
  | 'simulation'
  | 'approval'
  | 'signing'
  | 'broadcast'
  | 'reconciliation'
  | 'reporting'
  | 'completed'
  | 'failed'
  | 'halted'

export type KernelMode = 'interactive' | 'api' | 'automation' | 'daemon'

export type KernelInputKind =
  | 'operator_command'
  | 'conversational'
  | 'action_request'
  | 'status_query'
  | 'resume_signal'
  | 'callback_event'

export type RunStatus =
  | 'active'
  | 'waiting_for_input'
  | 'waiting_for_approval'
  | 'waiting_for_signature'
  | 'waiting_for_confirmation'
  | 'completed'
  | 'failed'
  | 'halted'

export type KernelBootstrapInput = {
  sessionId?: string
  mode: KernelMode
  environment: RuntimeEnvironment
  orgContext: {
    organizationId?: string
    treasuryIds?: string[]
    walletIds?: string[]
  }
  actorContext: {
    actorId: string
    roleIds: string[]
  }
  transcriptRef?: string
}

export type KernelInput = {
  sessionId: string
  inputId?: string
  kind?: KernelInputKind
  receivedAt?: ISO8601String
  source: 'operator' | 'api' | 'system'
  text?: string
  runId?: string
  requestedActionType?: IntentActionType
  payload?: Record<string, unknown>
}

export type KernelCallbackEvent =
  | {
      type: 'approval_decision'
      runId: string
      receivedAt?: ISO8601String
      status: 'approved' | 'rejected' | 'expired' | 'invalidated'
      approvalStateRef?: string
      requirementId?: string
      viewedMaterialHash?: string
      viewedAt?: ISO8601String
      breakGlassReason?: string
      approvalRecord?: {
        approvalRecordId?: string
        approver: {
          actorId: string
          role: string
        }
        comment?: string
        evidenceRef?: string
        decidedAt?: ISO8601String
      }
      summary?: string
    }
  | {
      type: 'compliance_status'
      runId: string
      walletId: string
      complianceWorkflowId: string
      workflowType: ComplianceWorkflowType
      receivedAt?: ISO8601String
      status: Exclude<ComplianceWorkflowStatus, 'initiated'>
      providerId?: string
      providerCaseId?: string
      reviewedAt?: ISO8601String
      evidenceRef?: string
      summary?: string
    }
  | {
      type: 'signature_status'
      runId: string
      receivedAt?: ISO8601String
      status: SignatureResultStatus
      signatureRequestId: string
      transactionHash?: string
      summary?: string
    }
  | {
      type: 'broadcast_confirmation'
      runId: string
      receivedAt?: ISO8601String
      status: 'confirmed' | 'failed'
      broadcastRef: string
      transactionHash?: string
      summary?: string
    }

export type TranscriptEntry = {
  entryId: string
  at: ISO8601String
  sessionId: string
  runId?: string
  role: 'operator' | 'assistant' | 'system'
  content: string
}

export type SessionState = {
  sessionId: string
  createdAt: ISO8601String
  updatedAt: ISO8601String
  mode: KernelMode
  environment: RuntimeEnvironment
  orgContext: {
    organizationId?: string
    treasuryIds?: string[]
    walletIds?: string[]
  }
  actorContext: {
    actorId: string
    roleIds: string[]
  }
  activeRunId?: string
  runIds: string[]
  pendingApprovalRunIds: string[]
  pendingSignatureRunIds: string[]
  pendingConfirmationRunIds: string[]
  halted: boolean
  transcriptRef: string
}

export type RunState = {
  runId: string
  sessionId: string
  actionType: IntentActionType | 'unknown'
  status: RunStatus
  currentPhase: RuntimePhase
  intentRef?: {
    intentId: string
    version: string
  }
  policyRef?: {
    resolutionId: string
  }
  approvalStateRef?: string
  simulationRefs: string[]
  signatureRequestRefs: string[]
  signatureResultRefs: string[]
  broadcastRefs: string[]
  intentArtifactPath?: string
  policyArtifactPath?: string
  approvalArtifactPath?: string
  approvalReviewArtifactPath?: string
  simulationArtifactPaths: string[]
  signatureRequestArtifactPaths: string[]
  signatureResultArtifactPaths: string[]
  broadcastArtifactPaths: string[]
  reconciliationArtifactPath?: string
  reportArtifactPath?: string
  reportRef?: string
  lastUpdatedAt: ISO8601String
}

export type KernelTurnResult = {
  kind: KernelInputKind
  createdRun: boolean
  session: SessionState
  run?: RunState
  output: string[]
}

export type RunPhaseTransition = {
  from: RuntimePhase
  to: RuntimePhase
  reason: string
}

export interface SessionKernel {
  loadOrCreateSession(input: KernelBootstrapInput): Promise<SessionState>
  handleInput(input: KernelInput): Promise<KernelTurnResult>
  resumeRun(runId: string): Promise<RunState>
  ingestCallback(event: KernelCallbackEvent): Promise<void>
  haltRun(runId: string, reason: string): Promise<void>
  closeSession(sessionId: string): Promise<void>
}

export type LedgerActorContext = RuntimeActor
