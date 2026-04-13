/**
 * smoke-test-wallet-compliance-callback.ts
 * Validates compliance provider callbacks for wallet onboarding lifecycle updates.
 * Run: bun cli/smoke-test-wallet-compliance-callback.ts
 */

import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { DefaultSessionKernel } from '../src/runtime/SessionKernel.js'
import { FileKernelPersistence } from '../src/runtime/kernelPersistence.js'
import { FileRunRegistry } from '../src/runtime/runRegistry.js'
import { FileWalletRegistry } from '../src/wallets/WalletRegistry.js'
import type { PolicyProfile } from '../src/contracts/policy.js'
import type { SessionKernel } from '../src/contracts/runtime.js'
import type { WalletRecord } from '../src/contracts/wallet.js'

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

function buildWalletPolicy(): PolicyProfile {
  const now = new Date().toISOString()
  return {
    policyProfileId: 'wallet_compliance_callback_policy',
    version: '1',
    createdAt: now,
    updatedAt: now,
    owner: { organizationId: 'org_wallet_compliance' },
    mode: 'copilot',
    scope: {
      environments: ['development'],
      allowedChains: [],
      allowedAssets: [],
    },
    permissions: {
      actions: {
        'wallet.create': {
          enabled: true,
          allowedSignerClasses: ['mpc', 'multisig', 'smart_account', 'custodial', 'hardware'],
          simulationRequired: false,
          approvalRequired: false,
        },
      },
      counterparty: {},
      protocols: {},
      signer: {
        allowedSignerClasses: ['mpc', 'multisig', 'smart_account', 'custodial', 'hardware'],
      },
      simulation: {},
    },
    approvals: {},
    identity: {},
    trust: {},
    emergency: { emergencyHaltEnabled: false },
  }
}

async function createHarness(): Promise<{
  kernel: SessionKernel
  wallets: FileWalletRegistry
}> {
  const persistence = new FileKernelPersistence(runsDir)
  const runs = new FileRunRegistry(runsDir)
  const wallets = new FileWalletRegistry(runsDir)
  const kernel = new DefaultSessionKernel({
    persistence,
    runs,
    walletRegistry: wallets,
    getPolicyCandidates: async () => [buildWalletPolicy()],
  })

  return { kernel, wallets }
}

async function createSession(kernel: SessionKernel, organizationId: string) {
  return kernel.loadOrCreateSession({
    mode: 'interactive',
    environment: 'development',
    orgContext: {
      organizationId,
    },
    actorContext: {
      actorId: 'operator_wallet_compliance',
      roleIds: ['ops'],
    },
  })
}

async function createWalletRun(
  kernel: SessionKernel,
  sessionId: string,
  input: {
    subjectId: string
    subjectType: 'individual' | 'business'
    walletType: 'vendor' | 'ops'
  },
) {
  return kernel.handleInput({
    sessionId,
    source: 'operator',
    requestedActionType: 'wallet.create',
    payload: {
      subjectId: input.subjectId,
      subjectType: input.subjectType,
      walletType: input.walletType,
      signerProfileId: 'mpc_default',
      initialPolicyProfileId: 'wallet_compliance_callback_policy',
    },
  })
}

async function findWalletBySubject(
  wallets: FileWalletRegistry,
  subjectId: string,
): Promise<WalletRecord> {
  const allWallets = await wallets.list()
  const match = allWallets
    .filter((wallet) => wallet.subjectId === subjectId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
  if (!match) {
    throw new Error(`Wallet not found for subject ${subjectId}.`)
  }

  return match
}

async function testVendorPromotion(): Promise<void> {
  step('Vendor Wallet Compliance Approval')
  const { kernel, wallets } = await createHarness()
  const session = await createSession(
    kernel,
    `org_wallet_compliance_vendor_${Date.now().toString(36)}`,
  )
  const runResult = await createWalletRun(kernel, session.sessionId, {
    subjectId: 'vendor_javier',
    subjectType: 'individual',
    walletType: 'vendor',
  })
  const run = runResult.run
  if (!run) {
    fail('Expected wallet.create run for vendor compliance test.')
  }

  const createdWallet = await findWalletBySubject(wallets, 'vendor_javier')
  if (createdWallet.complianceStatus !== 'pending') {
    fail(`Expected pending compliance after kickoff, got ${createdWallet.complianceStatus}.`)
  }
  if (!createdWallet.complianceWorkflowId) {
    fail('Expected compliance workflow id after wallet kickoff.')
  }
  if (!createdWallet.complianceProviderId) {
    fail('Expected compliance provider id after compliance kickoff.')
  }
  if (!createdWallet.complianceProviderCaseId) {
    fail('Expected provider case id after compliance kickoff.')
  }
  if (createdWallet.trustStatus !== 'limited') {
    fail(`Expected initial wallet trust baseline to be limited, got ${createdWallet.trustStatus}.`)
  }
  ok('Vendor wallet started in pending compliance state.')

  await kernel.ingestCallback({
    type: 'compliance_status',
    runId: run.runId,
    walletId: createdWallet.walletId,
    complianceWorkflowId: createdWallet.complianceWorkflowId,
    workflowType: 'kyc',
    status: 'approved',
    providerId: createdWallet.complianceProviderId,
    providerCaseId: createdWallet.complianceProviderCaseId,
    reviewedAt: new Date().toISOString(),
    evidenceRef: 'compliance://case/vendor_javier',
  })

  const approvedWallet = await findWalletBySubject(wallets, 'vendor_javier')
  if (approvedWallet.complianceStatus !== 'approved') {
    fail(`Expected approved compliance, got ${approvedWallet.complianceStatus}.`)
  }
  if (approvedWallet.state !== 'active_receive_only') {
    fail(`Expected vendor wallet to auto-promote to active_receive_only, got ${approvedWallet.state}.`)
  }
  if (approvedWallet.trustStatus !== 'sufficient') {
    fail(`Expected approved vendor wallet trust to upgrade to sufficient, got ${approvedWallet.trustStatus}.`)
  }
  ok('Approved vendor wallet auto-promoted to active_receive_only.')

  const pendingComplianceResult = await kernel.handleInput({
    sessionId: session.sessionId,
    source: 'operator',
    kind: 'operator_command',
    payload: { command: 'pending_compliance' },
  })
  if (
    !pendingComplianceResult.output.some(
      (line) =>
        line.includes('Pending compliance workflows: 0') ||
        line.includes('No wallets are currently pending compliance.'),
    )
  ) {
    fail('Expected pending compliance command to show zero pending workflows after vendor approval.')
  }
  ok('Pending compliance operator command reflected the updated workflow state.')

  await kernel.closeSession(session.sessionId)
}

async function testOpsRemainsNonSpendable(): Promise<void> {
  step('Ops Wallet Compliance Approval')
  const { kernel, wallets } = await createHarness()
  const session = await createSession(
    kernel,
    `org_wallet_compliance_ops_${Date.now().toString(36)}`,
  )
  const runResult = await createWalletRun(kernel, session.sessionId, {
    subjectId: 'ops_treasury_assistant',
    subjectType: 'individual',
    walletType: 'ops',
  })
  const run = runResult.run
  if (!run) {
    fail('Expected wallet.create run for ops compliance test.')
  }

  const createdWallet = await findWalletBySubject(wallets, 'ops_treasury_assistant')
  if (!createdWallet.complianceWorkflowId) {
    fail('Expected compliance workflow id for ops wallet.')
  }
  if (!createdWallet.complianceProviderId) {
    fail('Expected compliance provider id for ops wallet.')
  }
  if (!createdWallet.complianceProviderCaseId) {
    fail('Expected provider case id for ops wallet.')
  }
  if (createdWallet.trustStatus !== 'limited') {
    fail(`Expected initial ops wallet trust baseline to be limited, got ${createdWallet.trustStatus}.`)
  }

  let mismatchedCaseAccepted = false
  try {
    await kernel.ingestCallback({
      type: 'compliance_status',
      runId: run.runId,
      walletId: createdWallet.walletId,
      complianceWorkflowId: createdWallet.complianceWorkflowId,
      workflowType: 'kyc',
      status: 'approved',
      providerId: createdWallet.complianceProviderId,
      providerCaseId: 'wrong_case_id',
      reviewedAt: new Date().toISOString(),
    })
    mismatchedCaseAccepted = true
  } catch {
    ok('Mismatched compliance provider case was rejected as expected.')
  }
  if (mismatchedCaseAccepted) {
    fail('Mismatched compliance provider case was accepted unexpectedly.')
  }

  await kernel.ingestCallback({
    type: 'compliance_status',
    runId: run.runId,
    walletId: createdWallet.walletId,
    complianceWorkflowId: createdWallet.complianceWorkflowId,
    workflowType: 'kyc',
    status: 'approved',
    providerId: createdWallet.complianceProviderId,
    providerCaseId: createdWallet.complianceProviderCaseId,
    reviewedAt: new Date().toISOString(),
  })

  const approvedWallet = await findWalletBySubject(wallets, 'ops_treasury_assistant')
  if (approvedWallet.complianceStatus !== 'approved') {
    fail(`Expected approved compliance, got ${approvedWallet.complianceStatus}.`)
  }
  if (approvedWallet.state !== 'pending_compliance') {
    fail(`Expected ops wallet to remain pending_compliance until activation, got ${approvedWallet.state}.`)
  }
  if (approvedWallet.trustStatus !== 'sufficient') {
    fail(`Expected approved ops wallet trust to upgrade to sufficient, got ${approvedWallet.trustStatus}.`)
  }
  ok('Approved ops wallet remained non-spendable pending explicit activation.')

  const complianceStatusResult = await kernel.handleInput({
    sessionId: session.sessionId,
    source: 'operator',
    kind: 'operator_command',
    payload: {
      command: 'compliance_status',
      target: approvedWallet.walletId,
    },
  })
  if (!complianceStatusResult.output.some((line) => line.includes('compliance status: approved'))) {
    fail('Expected compliance status command to show approved compliance.')
  }
  if (!complianceStatusResult.output.some((line) => line.includes('Wallet state: pending_compliance'))) {
    fail('Expected compliance status command to show pending_compliance wallet state.')
  }
  ok('Compliance status operator command returned the current workflow state.')

  await kernel.closeSession(session.sessionId)
}

async function main() {
  console.log(`\n${BOLD}Wallet Agent OS — Wallet Compliance Callback Smoke Test${RESET}`)
  console.log('─'.repeat(60))

  await testVendorPromotion()
  await testOpsRemainsNonSpendable()

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`${GREEN}${BOLD}Wallet compliance callback checks passed.${RESET}\n`)
}

main().catch((error) => {
  console.error('\nFatal:', error)
  process.exit(1)
})
