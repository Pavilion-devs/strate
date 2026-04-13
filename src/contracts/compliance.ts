import type { ISO8601String } from './common.js'

export type ComplianceWorkflowType = 'kyc' | 'kyb'

export type ComplianceWorkflowStatus =
  | 'initiated'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'restricted'

export type ComplianceWorkflowRecord = {
  complianceWorkflowId: string
  walletId: string
  subjectId?: string
  subjectType?: 'individual' | 'team' | 'business'
  workflowType: ComplianceWorkflowType
  status: ComplianceWorkflowStatus
  providerId?: string
  providerCaseId?: string
  createdAt: ISO8601String
  updatedAt: ISO8601String
  reviewedAt?: ISO8601String
  initiatedBy?: string
  evidenceRef?: string
}

export type ComplianceStartInput = {
  complianceWorkflowId: string
  walletId: string
  subjectId?: string
  subjectType?: 'individual' | 'team' | 'business'
  workflowType: ComplianceWorkflowType
  organizationId?: string
  initiatedAt: ISO8601String
  initiatedBy?: string
}

export type ComplianceStartResult = {
  providerId: string
  providerCaseId: string
  workflow: ComplianceWorkflowRecord
}

export type ComplianceStatusUpdateInput = {
  workflow: ComplianceWorkflowRecord
  status: Exclude<ComplianceWorkflowStatus, 'initiated'>
  providerId?: string
  providerCaseId?: string
  reviewedAt?: ISO8601String
  evidenceRef?: string
  at: ISO8601String
}

export type ComplianceStatusUpdateResult = {
  workflow: ComplianceWorkflowRecord
}

export interface ComplianceProvider {
  startWorkflow(input: ComplianceStartInput): Promise<ComplianceStartResult>
  applyStatusUpdate(
    input: ComplianceStatusUpdateInput,
  ): Promise<ComplianceStatusUpdateResult>
}
