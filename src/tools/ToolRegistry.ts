import type {
  ToolDefinition,
  ToolExecutionContext,
} from '../contracts/tools.js'

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<unknown, unknown>>()

  register<Input, Output>(tool: ToolDefinition<Input, Output>): void {
    this.tools.set(tool.id, tool as ToolDefinition<unknown, unknown>)
  }

  get(toolId: string): ToolDefinition<unknown, unknown> | undefined {
    return this.tools.get(toolId)
  }

  list(): Array<ToolDefinition<unknown, unknown>> {
    return [...this.tools.values()]
  }

  listForPhase(
    phase: ToolExecutionContext['phase'],
  ): Array<ToolDefinition<unknown, unknown>> {
    return this.list().filter((tool) => tool.allowedPhases.includes(phase))
  }

  canRun(toolId: string, context: ToolExecutionContext): boolean {
    const tool = this.get(toolId)
    if (!tool) {
      return false
    }

    if (!tool.allowedPhases.includes(context.phase)) {
      return false
    }

    if (tool.requiresApproval && context.approvalState?.status !== 'approved') {
      return false
    }

    if (
      tool.requiresPolicy &&
      (!context.resolvedPolicyProfile ||
        context.resolvedPolicyProfile.status === 'denied')
    ) {
      return false
    }

    return true
  }
}
