/**
 * smoke-test-external-approval-client.ts
 * Validates the external approval client adapter against runtime review packages
 * and structured decision submissions.
 * Run: bun cli/smoke-test-external-approval-client.ts
 */

import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readFile } from 'fs/promises'
import { RuntimeApprovalClient } from '../src/approval/RuntimeApprovalClient.js'
import { DefaultSessionKernel } from '../src/runtime/SessionKernel.js'
import { FileKernelPersistence } from '../src/runtime/kernelPersistence.js'
import { FileRunRegistry } from '../src/runtime/runRegistry.js'
import type { PolicyProfile } from '../src/contracts/policy.js'
import type { ApprovalState } from '../src/contracts/approval.js'
import type { ApprovalReviewPackage } from '../src/contracts/approvalReview.js'
import type { SessionKernel } from '../src/contracts/runtime.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const runsDir = join(__dirname, '..', 'runs')

const RESET = '\x1b[0m'
const GREEN = '\x1b[32m'
const CYAN = '\x1b[36m'
const RED = '\x1b[31m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'

function step(label: string) {
  console.log(`\n${CYAN}${BOLD}▶ ${label}${RESET}`)
}

function ok(message: string) {
  console.log(`  ${GREEN}✓${RESET} ${message}`)
}

function info(message: string) {
  console.log(`  ${DIM}${message}${RESET}`)
}

function fail(message: string): never {
  console.log(`  ${RED}✗ ${message}${RESET}`)
  process.exit(1)
}

function buildRoleSplitPolicy(): PolicyProfile {
  const now = new Date().toISOString()
  return {
    policyProfileId: 'external_approval_client_role_split',
    version: '1',
    createdAt: now,
    updatedAt: now,
    owner: { organizationId: 'org_external_approval' },
    mode: 'copilot',
    scope: {
      environments: ['development'],
      allowedChains: [],
      allowedAssets: [],
    },
    permissions: {
      actions: {
        'asset.transfer': {
          enabled: true,
          allowedSignerClasses: ['mpc', 'multisig', 'smart_account', 'custodial', 'hardware'],
          simulationRequired: true,
          approvalRequired: true,
        },
      },
      counterparty: {},
      protocols: {},
      signer: {
        allowedSignerClasses: ['mpc', 'multisig', 'smart_account', 'custodial', 'hardware'],
      },
      simulation: {
        requireTransferSimulation: true,
        simulationFreshnessSeconds: 300,
      },
    },
    approvals: {
      'asset.transfer': {
        dualApprovalOver: '1',
        requiredRoles: ['finance', 'compliance'],
        roleSeparationRequired: true,
        approvalExpirySeconds: 600,
      },
    },
    identity: {},
    trust: {},
    emergency: { emergencyHaltEnabled: false },
  }
}

function buildBreakGlassPolicy(): PolicyProfile {
  const now = new Date().toISOString()
  return {
    policyProfileId: 'external_approval_client_break_glass',
    version: '1',
    createdAt: now,
    updatedAt: now,
    owner: { organizationId: 'org_external_approval' },
    mode: 'copilot',
    scope: {
      environments: ['development'],
      allowedChains: [],
      allowedAssets: [],
    },
    permissions: {
      actions: {
        'asset.transfer': {
          enabled: true,
          allowedSignerClasses: ['mpc', 'multisig', 'smart_account', 'custodial', 'hardware'],
          simulationRequired: true,
          approvalRequired: true,
        },
      },
      counterparty: {},
      protocols: {},
      signer: {
        allowedSignerClasses: ['mpc', 'multisig', 'smart_account', 'custodial', 'hardware'],
      },
      simulation: {
        requireTransferSimulation: true,
        simulationFreshnessSeconds: 300,
      },
    },
    approvals: {
      'asset.transfer': {
        dualApprovalOver: '1',
        requiredRoles: ['finance', 'compliance'],
        roleSeparationRequired: true,
        approvalExpirySeconds: 600,
      },
    },
    identity: {},
    trust: {},
    emergency: {
      emergencyHaltEnabled: true,
      breakGlassRoles: ['admin'],
    },
  }
}

async function createHarness(policy: PolicyProfile): Promise<{
  kernel: SessionKernel
  client: RuntimeApprovalClient
}> {
  const persistence = new FileKernelPersistence(runsDir)
  const runs = new FileRunRegistry(runsDir)
  const kernel = new DefaultSessionKernel({
    persistence,
    runs,
    getPolicyCandidates: async () => [policy],
  })

  return {
    kernel,
    client: new RuntimeApprovalClient({
      kernel,
      runs,
    }),
  }
}

async function createSession(kernel: SessionKernel, actorId: string, role: string) {
  return kernel.loadOrCreateSession({
    mode: 'interactive',
    environment: 'development',
    orgContext: {
      organizationId: 'org_external_approval',
      walletIds: ['wallet_external_approval_source'],
    },
    actorContext: {
      actorId,
      roleIds: [role],
    },
  })
}

async function createTransferRun(kernel: SessionKernel, sessionId: string) {
  return kernel.handleInput({
    sessionId,
    source: 'operator',
    text: 'send 10 USDC to test recipient',
    requestedActionType: 'asset.transfer',
    payload: {
      sourceWalletId: 'wallet_external_approval_source',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      chainId: 'base',
      assetSymbol: 'USDC',
      amount: '10',
    },
  })
}

async function readApprovalState(path: string | undefined): Promise<ApprovalState> {
  if (!path) {
    throw new Error('Run is missing approval artifact path.')
  }

  const contents = await readFile(path, 'utf8')
  return JSON.parse(contents) as ApprovalState
}

async function testRoleSplitClientFlow(): Promise<void> {
  step('External Client Role-Split Flow')
  const { kernel, client } = await createHarness(buildRoleSplitPolicy())
  const session = await createSession(kernel, 'operator_external_finance', 'finance')
  const runResult = await createTransferRun(kernel, session.sessionId)
  const run = runResult.run
  if (!run) {
    fail('Expected run creation for external client role-split flow.')
  }
  if (run.status !== 'waiting_for_approval') {
    fail(`Expected waiting_for_approval, got ${run.status}.`)
  }

  const pendingReviews = await client.listPendingReviews(session.sessionId)
  if (!pendingReviews.some((review) => review.run.runId === run.runId)) {
    fail('Pending review list did not include the expected run.')
  }
  ok('Pending review package was discoverable through the external client.')

  const financeDecision = await client.submitDecision({
    runId: run.runId,
    actor: {
      actorId: 'approver_finance_ext_1',
      roleId: 'finance',
    },
    decision: 'approved',
    comment: 'Finance approved from external review system.',
    externalEvidenceRef: 'approval-system://finance/decision-1',
  })
  if (financeDecision.outcome !== 'accepted') {
    fail(`Expected accepted finance decision, got ${financeDecision.outcome}.`)
  }
  if (financeDecision.run.status !== 'waiting_for_approval') {
    fail(`Expected run to remain waiting_for_approval, got ${financeDecision.run.status}.`)
  }
  ok('First external approval was accepted and the run remained pending.')

  const complianceDecision = await client.submitDecision({
    runId: run.runId,
    actor: {
      actorId: 'approver_compliance_ext_1',
      roleId: 'compliance',
    },
    decision: 'approved',
    comment: 'Compliance approved from external review system.',
    externalEvidenceRef: 'approval-system://compliance/decision-2',
  })
  if (complianceDecision.outcome !== 'accepted') {
    fail(`Expected accepted compliance decision, got ${complianceDecision.outcome}.`)
  }
  if (complianceDecision.run.currentPhase !== 'signing') {
    fail(`Expected run to advance into signing, got ${complianceDecision.run.currentPhase}.`)
  }
  ok('Second external approval satisfied the role split and advanced the run.')

  const approvalState = await readApprovalState(complianceDecision.run.approvalArtifactPath)
  const evidenceRefs = approvalState.approvals.map((approval) => approval.evidenceRef)
  if (!evidenceRefs.includes('approval-system://finance/decision-1')) {
    fail('Expected finance evidence ref to persist on the approval record.')
  }
  if (!evidenceRefs.includes('approval-system://compliance/decision-2')) {
    fail('Expected compliance evidence ref to persist on the approval record.')
  }
  ok('External evidence references persisted in durable approval records.')

  await kernel.closeSession(session.sessionId)
}

async function testStaleDecisionRejection(): Promise<void> {
  step('External Client Stale Decision Rejection')
  const { kernel, client } = await createHarness(buildRoleSplitPolicy())
  const session = await createSession(kernel, 'operator_external_stale', 'finance')
  const runResult = await createTransferRun(kernel, session.sessionId)
  const run = runResult.run
  if (!run) {
    fail('Expected run creation for stale-decision client flow.')
  }

  const review = await client.getReviewPackage(run.runId)
  const staleDecision = await client.submitDecision({
    runId: run.runId,
    actor: {
      actorId: 'approver_finance_ext_stale',
      roleId: 'finance',
    },
    decision: 'approved',
    requirementId: review.reviewPackage.requirementId,
    approvalStateId: review.reviewPackage.approvalStateId,
    viewedMaterialHash: `${review.reviewPackage.materialView.materialHash}_tampered`,
    comment: 'This should be rejected as stale.',
  })

  if (staleDecision.outcome !== 'rejected_stale') {
    fail(`Expected rejected_stale outcome, got ${staleDecision.outcome}.`)
  }
  if (staleDecision.run.status !== 'waiting_for_approval') {
    fail(`Expected run to remain waiting_for_approval, got ${staleDecision.run.status}.`)
  }
  ok('Stale material-hash submission was rejected by the external client path.')

  await kernel.closeSession(session.sessionId)
}

async function testBreakGlassClientFlow(): Promise<void> {
  step('External Client Break-Glass Flow')
  const { kernel, client } = await createHarness(buildBreakGlassPolicy())
  const session = await createSession(kernel, 'operator_external_admin', 'admin')
  const runResult = await createTransferRun(kernel, session.sessionId)
  const run = runResult.run
  if (!run) {
    fail('Expected run creation for external break-glass flow.')
  }

  const decision = await client.submitDecision({
    runId: run.runId,
    actor: {
      actorId: 'approver_admin_ext_1',
      roleId: 'admin',
    },
    decision: 'approved',
    breakGlassReason: 'SEV1 payout recovery',
    comment: 'External incident system break-glass approval.',
    externalEvidenceRef: 'incident://sev1/approval-1',
  })

  if (decision.outcome !== 'accepted') {
    fail(`Expected accepted break-glass decision, got ${decision.outcome}.`)
  }
  if (decision.run.currentPhase !== 'signing') {
    fail(`Expected break-glass run to advance into signing, got ${decision.run.currentPhase}.`)
  }

  const packageAfterDecision = decision.reviewPackage as ApprovalReviewPackage
  info(`Break-glass package status: ${packageAfterDecision.status}`)
  ok('Break-glass decision path works through the external approval client.')

  await kernel.closeSession(session.sessionId)
}

async function main() {
  console.log(`\n${BOLD}Wallet Agent OS — External Approval Client Smoke Test${RESET}`)
  console.log('─'.repeat(60))

  await testRoleSplitClientFlow()
  await testStaleDecisionRejection()
  await testBreakGlassClientFlow()

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`${GREEN}${BOLD}External approval client checks passed.${RESET}\n`)
}

main().catch((error) => {
  console.error('\nFatal:', error)
  process.exit(1)
})
