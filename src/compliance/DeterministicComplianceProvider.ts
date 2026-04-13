import type {
  ComplianceProvider,
  ComplianceStartInput,
  ComplianceStartResult,
  ComplianceStatusUpdateInput,
  ComplianceStatusUpdateResult,
} from '../contracts/compliance.js'

export class DeterministicComplianceProvider implements ComplianceProvider {
  private readonly providerId: string

  constructor(providerId = 'deterministic_compliance_provider') {
    this.providerId = providerId
  }

  async startWorkflow(input: ComplianceStartInput): Promise<ComplianceStartResult> {
    const providerCaseId = `case_${input.complianceWorkflowId}`
    return {
      providerId: this.providerId,
      providerCaseId,
      workflow: {
        complianceWorkflowId: input.complianceWorkflowId,
        walletId: input.walletId,
        subjectId: input.subjectId,
        subjectType: input.subjectType,
        workflowType: input.workflowType,
        status: 'pending',
        providerId: this.providerId,
        providerCaseId,
        createdAt: input.initiatedAt,
        updatedAt: input.initiatedAt,
        initiatedBy: input.initiatedBy,
      },
    }
  }

  async applyStatusUpdate(
    input: ComplianceStatusUpdateInput,
  ): Promise<ComplianceStatusUpdateResult> {
    const providerId = input.providerId ?? input.workflow.providerId ?? this.providerId
    if (providerId !== this.providerId) {
      throw new Error(
        `Compliance provider mismatch. Expected ${this.providerId}, received ${providerId}.`,
      )
    }

    const providerCaseId = input.providerCaseId ?? input.workflow.providerCaseId
    if (input.workflow.providerCaseId && providerCaseId !== input.workflow.providerCaseId) {
      throw new Error(
        `Compliance provider case mismatch. Expected ${input.workflow.providerCaseId}, received ${providerCaseId}.`,
      )
    }

    return {
      workflow: {
        ...input.workflow,
        status: input.status,
        providerId,
        providerCaseId,
        reviewedAt: input.reviewedAt ?? input.at,
        evidenceRef: input.evidenceRef ?? input.workflow.evidenceRef,
        updatedAt: input.at,
      },
    }
  }
}
