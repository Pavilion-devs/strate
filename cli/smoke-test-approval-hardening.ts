/**
 * smoke-test-approval-hardening.ts
 * Validates role-split approvals and simulation-staleness invalidation before signing.
 * Run: bun cli/smoke-test-approval-hardening.ts
 */

import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readFile } from 'fs/promises'
import { DefaultSessionKernel } from '../src/runtime/SessionKernel.js'
import { FileKernelPersistence } from '../src/runtime/kernelPersistence.js'
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
    policyProfileId: 'approval_hardening_role_split',
    version: '1',
    createdAt: now,
    updatedAt: now,
    owner: { organizationId: 'org_approval_hardening' },
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
        approvalExpirySeconds: 300,
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
    policyProfileId: 'approval_hardening_break_glass',
    version: '1',
    createdAt: now,
    updatedAt: now,
    owner: { organizationId: 'org_approval_hardening' },
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

function buildStaleSimulationPolicy(): PolicyProfile {
  const now = new Date().toISOString()
  return {
    policyProfileId: 'approval_hardening_stale_simulation',
    version: '1',
    createdAt: now,
    updatedAt: now,
    owner: { organizationId: 'org_approval_hardening' },
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
        simulationFreshnessSeconds: 1,
      },
    },
    approvals: {
      'asset.transfer': {
        singleApprovalUnder: '1000000',
        requiredRoles: ['finance'],
        roleSeparationRequired: false,
        approvalExpirySeconds: 600,
      },
    },
    identity: {},
    trust: {},
    emergency: { emergencyHaltEnabled: false },
  }
}

async function createKernel(policy: PolicyProfile): Promise<SessionKernel> {
  return new DefaultSessionKernel({
    persistence: new FileKernelPersistence(runsDir),
    getPolicyCandidates: async () => [policy],
  })
}

async function createSession(kernel: SessionKernel, actorId: string, role: string) {
  return kernel.loadOrCreateSession({
    mode: 'interactive',
    environment: 'development',
    orgContext: {
      organizationId: 'org_approval_hardening',
      walletIds: ['wallet_approval_source'],
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
      sourceWalletId: 'wallet_approval_source',
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

async function testRoleSplit(): Promise<void> {
  step('Role-Split Approval Requirement')
  const kernel = await createKernel(buildRoleSplitPolicy())
  const session = await createSession(kernel, 'operator_finance_1', 'finance')
  const runResult = await createTransferRun(kernel, session.sessionId)
  const run = runResult.run
  if (!run) {
    fail('Expected run creation for role-split test.')
  }
  if (run.status !== 'waiting_for_approval') {
    fail(`Expected waiting_for_approval, got ${run.status}.`)
  }
  ok(`Run ${run.runId} entered waiting_for_approval.`)
  const approvalState = await readApprovalState(run.approvalArtifactPath)

  await kernel.ingestCallback({
    type: 'approval_decision',
    runId: run.runId,
    status: 'approved',
    requirementId: approvalState.requirement.requirementId,
    viewedMaterialHash: approvalState.requirement.materialHash,
    viewedAt: new Date().toISOString(),
    approvalRecord: {
      approver: { actorId: 'operator_finance_1', role: 'finance' },
      decidedAt: new Date().toISOString(),
      comment: 'Finance approval 1',
    },
  })
  const afterFinance = await kernel.resumeRun(run.runId)
  if (afterFinance.status !== 'waiting_for_approval') {
    fail(`Expected pending after first finance approval, got ${afterFinance.status}.`)
  }
  ok('First approval recorded; run still waiting for second role.')

  let duplicateAccepted = false
  try {
    await kernel.ingestCallback({
      type: 'approval_decision',
      runId: run.runId,
      status: 'approved',
      requirementId: approvalState.requirement.requirementId,
      viewedMaterialHash: approvalState.requirement.materialHash,
      viewedAt: new Date().toISOString(),
      approvalRecord: {
        approver: { actorId: 'operator_finance_1', role: 'finance' },
        decidedAt: new Date().toISOString(),
        comment: 'Duplicate finance approval should be rejected.',
      },
    })
    duplicateAccepted = true
  } catch {
    ok('Duplicate approver was rejected as expected.')
  }
  if (duplicateAccepted) {
    fail('Duplicate approver was accepted unexpectedly.')
  }

  let rejectedRoleAccepted = false
  try {
    await kernel.ingestCallback({
      type: 'approval_decision',
      runId: run.runId,
      status: 'approved',
      requirementId: approvalState.requirement.requirementId,
      viewedMaterialHash: approvalState.requirement.materialHash,
      viewedAt: new Date().toISOString(),
      approvalRecord: {
        approver: { actorId: 'operator_engineering_1', role: 'engineering' },
        decidedAt: new Date().toISOString(),
        comment: 'Engineering role should not be accepted.',
      },
    })
    rejectedRoleAccepted = true
  } catch {
    ok('Ineligible role was rejected as expected.')
  }
  if (rejectedRoleAccepted) {
    fail('Ineligible approval role was accepted unexpectedly.')
  }

  await kernel.ingestCallback({
    type: 'approval_decision',
    runId: run.runId,
    status: 'approved',
    requirementId: approvalState.requirement.requirementId,
    viewedMaterialHash: approvalState.requirement.materialHash,
    viewedAt: new Date().toISOString(),
    approvalRecord: {
      approver: { actorId: 'operator_compliance_1', role: 'compliance' },
      decidedAt: new Date().toISOString(),
      comment: 'Compliance approval 2',
    },
  })
  const afterCompliance = await kernel.resumeRun(run.runId)
  if (afterCompliance.currentPhase !== 'signing') {
    fail(`Expected signing phase after required roles approve, got ${afterCompliance.currentPhase}.`)
  }
  ok('Role-split requirement satisfied; run advanced into signing.')

  await kernel.closeSession(session.sessionId)
}

async function testStaleSimulationInvalidation(): Promise<void> {
  step('Simulation Staleness Invalidates Approval')
  const kernel = await createKernel(buildStaleSimulationPolicy())
  const session = await createSession(kernel, 'operator_finance_2', 'finance')
  const runResult = await createTransferRun(kernel, session.sessionId)
  const run = runResult.run
  if (!run) {
    fail('Expected run creation for stale simulation test.')
  }
  if (run.status !== 'waiting_for_approval') {
    fail(`Expected waiting_for_approval, got ${run.status}.`)
  }
  ok(`Run ${run.runId} entered waiting_for_approval.`)
  const approvalState = await readApprovalState(run.approvalArtifactPath)

  info('Waiting for simulation freshness to expire (1s)...')
  await new Promise((resolve) => setTimeout(resolve, 1200))

  await kernel.ingestCallback({
    type: 'approval_decision',
    runId: run.runId,
    status: 'approved',
    requirementId: approvalState.requirement.requirementId,
    viewedMaterialHash: approvalState.requirement.materialHash,
    viewedAt: new Date().toISOString(),
    approvalRecord: {
      approver: { actorId: 'operator_finance_2', role: 'finance' },
      decidedAt: new Date().toISOString(),
      comment: 'Approve after simulation freshness expiry.',
    },
  })

  const finalRun = await kernel.resumeRun(run.runId)
  if (finalRun.status !== 'failed') {
    fail(`Expected failed run after stale simulation approval, got ${finalRun.status}.`)
  }
  ok('Stale simulation prevented signing and failed the run safely.')

  await kernel.closeSession(session.sessionId)
}

async function testBreakGlassApproval(): Promise<void> {
  step('Break-Glass Approval Override')
  const kernel = await createKernel(buildBreakGlassPolicy())
  const session = await createSession(kernel, 'operator_admin_1', 'admin')
  const runResult = await createTransferRun(kernel, session.sessionId)
  const run = runResult.run
  if (!run) {
    fail('Expected run creation for break-glass test.')
  }
  if (run.status !== 'waiting_for_approval') {
    fail(`Expected waiting_for_approval, got ${run.status}.`)
  }
  const approvalState = await readApprovalState(run.approvalArtifactPath)

  await kernel.ingestCallback({
    type: 'approval_decision',
    runId: run.runId,
    status: 'approved',
    requirementId: approvalState.requirement.requirementId,
    viewedMaterialHash: approvalState.requirement.materialHash,
    viewedAt: new Date().toISOString(),
    breakGlassReason: 'SEV1 payout recovery',
    approvalRecord: {
      approver: { actorId: 'operator_admin_1', role: 'admin' },
      decidedAt: new Date().toISOString(),
      comment: 'Break-glass override for incident handling.',
    },
  })

  const afterBreakGlass = await kernel.resumeRun(run.runId)
  if (afterBreakGlass.currentPhase !== 'signing') {
    fail(`Expected signing phase after break-glass approval, got ${afterBreakGlass.currentPhase}.`)
  }
  ok('Break-glass approval advanced the run into signing.')

  await kernel.closeSession(session.sessionId)
}

async function testApprovalReviewPackageRetrieval(): Promise<void> {
  step('Approval Review Package Retrieval')
  const kernel = await createKernel(buildRoleSplitPolicy())
  const session = await createSession(kernel, 'operator_finance_pkg', 'finance')
  const runResult = await createTransferRun(kernel, session.sessionId)
  const run = runResult.run
  if (!run) {
    fail('Expected run creation for approval package retrieval test.')
  }
  if (run.status !== 'waiting_for_approval') {
    fail(`Expected waiting_for_approval, got ${run.status}.`)
  }

  const packageResult = await kernel.handleInput({
    sessionId: session.sessionId,
    source: 'operator',
    kind: 'operator_command',
    runId: run.runId,
    payload: { command: 'approval_package' },
  })
  const runWithPackage = packageResult.run
  if (!runWithPackage?.approvalReviewArtifactPath) {
    fail('Expected approval review package path on run state.')
  }

  const packageContents = await readFile(runWithPackage.approvalReviewArtifactPath, 'utf8')
  const reviewPackage = JSON.parse(packageContents) as ApprovalReviewPackage
  const approvalState = await readApprovalState(runWithPackage.approvalArtifactPath)
  if (reviewPackage.requirementId !== approvalState.requirement.requirementId) {
    fail('Approval review package requirementId did not match approval state requirement.')
  }
  ok('Approval review package command returned a valid runtime-generated package.')

  await kernel.closeSession(session.sessionId)
}

async function main() {
  console.log(`\n${BOLD}Wallet Agent OS — Approval Hardening Smoke Test${RESET}`)
  console.log('─'.repeat(60))

  await testRoleSplit()
  await testStaleSimulationInvalidation()
  await testBreakGlassApproval()
  await testApprovalReviewPackageRetrieval()

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`${GREEN}${BOLD}Approval hardening checks passed.${RESET}\n`)
}

main().catch((error) => {
  console.error('\nFatal:', error)
  process.exit(1)
})
