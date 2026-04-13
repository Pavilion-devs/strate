import type { ApprovalState } from './approval.js'
import type { ExecutionLedger } from './ledger.js'
import type { ResolvedPolicyProfile } from './policyResolution.js'
import type { RuntimePhase } from './runtime.js'

export type JsonSchema = Record<string, unknown>

export type ToolSideEffectLevel =
  | 'read_only'
  | 'controlled_write'
  | 'external_interaction'
  | 'protected_execution'

export type ToolPermissionMode =
  | 'always_allow'
  | 'policy_gated'
  | 'approval_gated'
  | 'protected_boundary'

export type SimulationState = {
  status: 'not_run' | 'fresh' | 'stale' | 'failed'
  latestSimulationRef?: string
  latestSimulationAt?: string
  freshnessSeconds?: number
}

export type SignerState = {
  status: 'unavailable' | 'ready' | 'pending' | 'failed'
  signerClass?: string
  signerProfileId?: string
}

export type ToolExecutionContext = {
  sessionId: string
  runId: string
  agentId: string
  agentRole: string
  phase: RuntimePhase
  intentRef?: {
    intentId: string
    version: string
  }
  resolvedPolicyProfile?: ResolvedPolicyProfile
  approvalState?: ApprovalState
  simulationState?: SimulationState
  signerState?: SignerState
  executionLedger: ExecutionLedger
}

export type ToolResult<Output> = {
  status: 'ok' | 'denied' | 'error'
  summary: string
  output?: Output
  artifacts?: Array<{
    kind:
      | 'note'
      | 'simulation'
      | 'approval'
      | 'signature'
      | 'broadcast'
      | 'ledger'
    path: string
  }>
  deniedReason?: string
  errorMessage?: string
}

export type ToolDefinition<Input, Output> = {
  id: string
  title: string
  description: string
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  sideEffectLevel: ToolSideEffectLevel
  permissionMode: ToolPermissionMode
  concurrency: 'safe_parallel' | 'serialized'
  allowedPhases: RuntimePhase[]
  producesArtifacts: boolean
  requiresIntent: boolean
  requiresPolicy: boolean
  requiresApproval: boolean
  defaultTimeoutMs: number
  execute(
    input: Input,
    context: ToolExecutionContext,
  ): Promise<ToolResult<Output>>
}
