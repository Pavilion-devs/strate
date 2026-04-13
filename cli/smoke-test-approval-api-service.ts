/**
 * smoke-test-approval-api-service.ts
 * Validates the stable approval API service surface and ledger audit events.
 * Run: bun cli/smoke-test-approval-api-service.ts
 */

import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { RuntimeApprovalClient } from '../src/approval/RuntimeApprovalClient.js'
import { DefaultSessionKernel } from '../src/runtime/SessionKernel.js'
import { RuntimeApprovalApiService } from '../src/runtime/ApprovalApiService.js'
import { FileKernelPersistence } from '../src/runtime/kernelPersistence.js'
import { FileRunRegistry } from '../src/runtime/runRegistry.js'
import type { PolicyProfile } from '../src/contracts/policy.js'
import type { SessionKernel } from '../src/contracts/runtime.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const runsDir = join(__dirname, '..', 'runs')

const RESET = '\x1b[0m'
const GREEN = '\x1b[32m'
const CYAN = '\x1b[36m'
const RED = '\x1b[31m'
const BOLD = '\x1b[1m'

function step(label: string) {
  console.log(`\n${CYAN}${BOLD}▶ ${label}${RESET}`)
}

function ok(message: string) {
  console.log(`  ${GREEN}✓${RESET} ${message}`)
}

function fail(message: string): never {
  console.log(`  ${RED}✗ ${message}${RESET}`)
  process.exit(1)
}

function buildRoleSplitPolicy(): PolicyProfile {
  const now = new Date().toISOString()
  return {
    policyProfileId: 'approval_api_service_role_split',
    version: '1',
    createdAt: now,
    updatedAt: now,
    owner: { organizationId: 'org_approval_api_service' },
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

async function createHarness(policy: PolicyProfile): Promise<{
  kernel: SessionKernel
  api: RuntimeApprovalApiService
  persistence: FileKernelPersistence
}> {
  const persistence = new FileKernelPersistence(runsDir)
  const runs = new FileRunRegistry(runsDir)
  const kernel = new DefaultSessionKernel({
    persistence,
    runs,
    getPolicyCandidates: async () => [policy],
  })
  const client = new RuntimeApprovalClient({
    kernel,
    runs,
  })

  return {
    kernel,
    api: new RuntimeApprovalApiService({
      client,
      ledger: persistence.ledger,
    }),
    persistence,
  }
}

async function createSession(kernel: SessionKernel, actorId: string, role: string) {
  return kernel.loadOrCreateSession({
    mode: 'interactive',
    environment: 'development',
    orgContext: {
      organizationId: 'org_approval_api_service',
      walletIds: ['wallet_approval_api_source'],
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
      sourceWalletId: 'wallet_approval_api_source',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      chainId: 'base',
      assetSymbol: 'USDC',
      amount: '10',
    },
  })
}

async function main() {
  console.log(`\n${BOLD}Wallet Agent OS — Approval API Service Smoke Test${RESET}`)
  console.log('─'.repeat(60))

  const { kernel, api, persistence } = await createHarness(buildRoleSplitPolicy())
  const session = await createSession(kernel, 'operator_api_service', 'finance')

  step('Create approval-required run')
  const runResult = await createTransferRun(kernel, session.sessionId)
  const run = runResult.run
  if (!run) {
    fail('Expected run creation for approval API service test.')
  }
  if (run.status !== 'waiting_for_approval') {
    fail(`Expected waiting_for_approval, got ${run.status}.`)
  }
  ok(`Run ${run.runId} entered waiting_for_approval.`)

  step('List pending reviews')
  const pending = await api.listPendingReviews({ sessionId: session.sessionId })
  if (!pending.reviews.some((review) => review.run.runId === run.runId)) {
    fail('Pending review list did not include the created run.')
  }
  ok('Pending reviews were listed through the approval API service.')

  step('Render approval review package')
  const rendered = await api.getApprovalReview({
    runId: run.runId,
    viewer: {
      actorType: 'human',
      actorId: 'finance_reviewer_api',
      role: 'finance',
    },
    surface: 'external_api',
  })
  if (rendered.review.reviewPackage.requirementId.length === 0) {
    fail('Rendered review package did not include requirementId.')
  }
  ok('Approval review package was rendered through the stable API service.')

  step('Submit role-split approvals')
  const financeDecision = await api.submitApprovalDecision({
    runId: run.runId,
    actor: {
      actorId: 'finance_approver_api',
      roleId: 'finance',
    },
    decision: 'approved',
    comment: 'Finance approval via approval API service.',
    externalEvidenceRef: 'approval-api://finance/decision-1',
    surface: 'external_api',
  })
  if (financeDecision.outcome !== 'accepted') {
    fail(`Expected accepted finance decision, got ${financeDecision.outcome}.`)
  }
  ok('Finance approval submission was accepted by the API service.')

  const complianceDecision = await api.submitApprovalDecision({
    runId: run.runId,
    actor: {
      actorId: 'compliance_approver_api',
      roleId: 'compliance',
    },
    decision: 'approved',
    comment: 'Compliance approval via approval API service.',
    externalEvidenceRef: 'approval-api://compliance/decision-2',
    surface: 'external_api',
  })
  if (complianceDecision.outcome !== 'accepted') {
    fail(`Expected accepted compliance decision, got ${complianceDecision.outcome}.`)
  }
  if (complianceDecision.run.currentPhase !== 'signing') {
    fail(`Expected run to advance into signing, got ${complianceDecision.run.currentPhase}.`)
  }
  ok('Role-split approval advanced the run through the API service path.')

  step('Verify ledger audit events')
  const events = await persistence.ledger.listForRun(run.runId)
  if (!events.some((event) => event.eventType === 'approval.request_rendered')) {
    fail('Expected approval.request_rendered event in ledger.')
  }
  if (!events.some((event) => event.eventType === 'approval.submission_received')) {
    fail('Expected approval.submission_received event in ledger.')
  }
  ok('Approval API interactions were written to the execution ledger.')

  await kernel.closeSession(session.sessionId)

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`${GREEN}${BOLD}Approval API service checks passed.${RESET}\n`)
}

main().catch((error) => {
  console.error('\nFatal:', error)
  process.exit(1)
})
