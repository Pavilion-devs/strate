import { readFile } from 'fs/promises'
import type {
  ApprovalDecisionSubmission,
  ApprovalReviewEnvelope,
  ApprovalSubmissionOutcome,
  ApprovalSubmissionResult,
  ExternalApprovalClient,
} from '../contracts/approvalClient.js'
import type { ApprovalState } from '../contracts/approval.js'
import type { ApprovalReviewPackage } from '../contracts/approvalReview.js'
import type { SessionKernel } from '../contracts/runtime.js'
import type { RunRegistry } from '../runtime/runRegistry.js'

type RuntimeApprovalClientDependencies = {
  kernel: SessionKernel
  runs: RunRegistry
  now?: () => string
}

async function readJsonFile<T>(path: string): Promise<T> {
  const contents = await readFile(path, 'utf8')
  return JSON.parse(contents) as T
}

function mapSubmissionError(error: unknown): {
  outcome: ApprovalSubmissionOutcome
  message: string
} {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()

  if (
    normalized.includes('not eligible') ||
    normalized.includes('not allowed') ||
    normalized.includes('not authorized')
  ) {
    return {
      outcome: 'rejected_ineligible',
      message,
    }
  }

  if (
    normalized.includes('stale') ||
    normalized.includes('material hash mismatch') ||
    normalized.includes('requirement mismatch')
  ) {
    return {
      outcome: 'rejected_stale',
      message,
    }
  }

  if (normalized.includes('expired')) {
    return {
      outcome: 'rejected_expired',
      message,
    }
  }

  if (
    normalized.includes('already submitted') ||
    normalized.includes('already terminal')
  ) {
    return {
      outcome: 'rejected_duplicate',
      message,
    }
  }

  return {
    outcome: 'rejected_conflict',
    message,
  }
}

export class RuntimeApprovalClient implements ExternalApprovalClient {
  private readonly kernel: SessionKernel
  private readonly runs: RunRegistry
  private readonly now: () => string

  constructor(dependencies: RuntimeApprovalClientDependencies) {
    this.kernel = dependencies.kernel
    this.runs = dependencies.runs
    this.now = dependencies.now ?? (() => new Date().toISOString())
  }

  async listPendingReviews(sessionId: string): Promise<ApprovalReviewEnvelope[]> {
    const runs = await this.runs.listBySession(sessionId)
    const pendingRuns = runs
      .filter((run) => run.status === 'waiting_for_approval')
      .sort((left, right) => right.lastUpdatedAt.localeCompare(left.lastUpdatedAt))

    return Promise.all(
      pendingRuns.map((run) => this.getReviewPackage(run.runId)),
    )
  }

  async getReviewPackage(runId: string): Promise<ApprovalReviewEnvelope> {
    let run = await this.requireRun(runId)

    if (!run.approvalReviewArtifactPath) {
      const result = await this.kernel.handleInput({
        sessionId: run.sessionId,
        source: 'api',
        kind: 'operator_command',
        runId,
        payload: { command: 'approval_package' },
      })
      run = result.run ?? (await this.requireRun(runId))
    }

    if (!run.approvalReviewArtifactPath) {
      throw new Error(`Run ${runId} has no approval review package artifact.`)
    }

    const reviewPackage = await readJsonFile<ApprovalReviewPackage>(
      run.approvalReviewArtifactPath,
    )

    return {
      run,
      approvalStateRef: run.approvalStateRef,
      artifactPath: run.approvalReviewArtifactPath,
      reviewPackage,
    }
  }

  async submitDecision(
    input: ApprovalDecisionSubmission,
  ): Promise<ApprovalSubmissionResult> {
    const envelope = await this.getReviewPackage(input.runId)
    const viewedAt = input.viewedAt ?? this.now()
    const decidedAt = input.decidedAt ?? viewedAt

    try {
      await this.kernel.ingestCallback({
        type: 'approval_decision',
        runId: input.runId,
        status: input.decision,
        approvalStateRef:
          input.approvalStateId ?? envelope.reviewPackage.approvalStateId,
        requirementId:
          input.requirementId ?? envelope.reviewPackage.requirementId,
        viewedMaterialHash:
          input.viewedMaterialHash ??
          envelope.reviewPackage.materialView.materialHash,
        viewedAt,
        breakGlassReason: input.breakGlassReason,
        approvalRecord: {
          approver: {
            actorId: input.actor.actorId,
            role: input.actor.roleId,
          },
          decidedAt,
          comment: input.comment,
          evidenceRef: input.externalEvidenceRef,
        },
      })

      const run = await this.kernel.resumeRun(input.runId)
      const approvalState = await this.readApprovalState(run.approvalArtifactPath)
      const reviewPackage = run.approvalReviewArtifactPath
        ? await readJsonFile<ApprovalReviewPackage>(run.approvalReviewArtifactPath)
        : envelope.reviewPackage

      return {
        outcome: 'accepted',
        run,
        approvalState,
        reviewPackage,
        message: `Approval decision accepted for run ${input.runId}.`,
      }
    } catch (error) {
      const run = await this.requireRun(input.runId)
      const approvalState = await this.readApprovalState(run.approvalArtifactPath)
      const mapped = mapSubmissionError(error)
      return {
        outcome: mapped.outcome,
        run,
        approvalState,
        reviewPackage: envelope.reviewPackage,
        message: mapped.message,
      }
    }
  }

  private async requireRun(runId: string) {
    const run = await this.runs.get(runId)
    if (!run) {
      throw new Error(`Run ${runId} not found.`)
    }

    return run
  }

  private async readApprovalState(path: string | undefined): Promise<ApprovalState | undefined> {
    if (!path) {
      return undefined
    }

    return readJsonFile<ApprovalState>(path)
  }
}
