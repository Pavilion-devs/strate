/**
 * smoke-test-approval-api-http.ts
 * Validates the HTTP transport boundary for approval review and submission.
 * Run: bun cli/smoke-test-approval-api-http.ts
 */

import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createHmac } from 'crypto'
import { RuntimeApprovalClient } from '../src/approval/RuntimeApprovalClient.js'
import { DefaultSessionKernel } from '../src/runtime/SessionKernel.js'
import { RuntimeApprovalApiService } from '../src/runtime/ApprovalApiService.js'
import { ApprovalApiHttpServer } from '../src/runtime/ApprovalApiHttpServer.js'
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

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
  return `{${entries.join(',')}}`
}

function signWebhook(input: {
  secret: string
  timestamp: string
  method: string
  url: string
  body: Record<string, unknown>
}): string {
  const payload = stableStringify(input.body)
  return createHmac('sha256', input.secret)
    .update(`${input.timestamp}.${input.method.toUpperCase()}.${input.url}.${payload}`)
    .digest('hex')
}

function buildRoleSplitPolicy(): PolicyProfile {
  const now = new Date().toISOString()
  return {
    policyProfileId: 'approval_api_http_role_split',
    version: '1',
    createdAt: now,
    updatedAt: now,
    owner: { organizationId: 'org_approval_api_http' },
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
  server: ApprovalApiHttpServer
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
  const service = new RuntimeApprovalApiService({
    client,
    ledger: persistence.ledger,
  })
  const server = new ApprovalApiHttpServer({
    service,
    bearerCredentials: [
      {
        token: 'reviewer-token',
        permissions: ['review'],
        actorId: 'finance_viewer_http',
        roleId: 'finance',
      },
    ],
    webhookCredentials: [
      {
        keyId: 'finance-key',
        secret: 'finance-secret',
        permissions: ['decision'],
        actorId: 'finance_approver_http',
        roleId: 'finance',
      },
      {
        keyId: 'compliance-key',
        secret: 'compliance-secret',
        permissions: ['decision'],
        actorId: 'compliance_approver_http',
        roleId: 'compliance',
      },
    ],
  })

  return {
    kernel,
    server,
  }
}

async function createSession(kernel: SessionKernel, actorId: string, role: string) {
  return kernel.loadOrCreateSession({
    mode: 'interactive',
    environment: 'development',
    orgContext: {
      organizationId: 'org_approval_api_http',
      walletIds: ['wallet_approval_api_http_source'],
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
      sourceWalletId: 'wallet_approval_api_http_source',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      chainId: 'base',
      assetSymbol: 'USDC',
      amount: '10',
    },
  })
}

async function main() {
  console.log(`\n${BOLD}Wallet Agent OS — Approval API HTTP Smoke Test${RESET}`)
  console.log('─'.repeat(60))

  const { kernel, server } = await createHarness(buildRoleSplitPolicy())
  const session = await createSession(kernel, 'operator_api_http', 'finance')
  const runResult = await createTransferRun(kernel, session.sessionId)
  const run = runResult.run
  if (!run) {
    fail('Expected run creation for approval API HTTP test.')
  }

  try {
    step('Health check')
    const health = await server.dispatch({
      method: 'GET',
      url: '/health',
    })
    if (health.statusCode !== 200) {
      fail(`Expected healthy HTTP service, got ${health.statusCode}.`)
    }
    ok('HTTP transport responded on /health.')

    step('Reject unauthenticated review access')
    const unauthorizedPending = await server.dispatch({
      method: 'GET',
      url: `/sessions/${session.sessionId}/approval-reviews?limit=10`,
    })
    if (unauthorizedPending.statusCode !== 401) {
      fail(`Expected 401 for unauthenticated review access, got ${unauthorizedPending.statusCode}.`)
    }
    ok('Unauthenticated review access was rejected.')

    step('List pending review packages')
    const pendingBody = await server.dispatch({
      method: 'GET',
      url: `/sessions/${session.sessionId}/approval-reviews?limit=10`,
      headers: {
        authorization: 'Bearer reviewer-token',
      },
    })
    const reviews = pendingBody.body['reviews']
    if (!Array.isArray(reviews) || reviews.length === 0) {
      fail('Expected at least one pending review from HTTP transport.')
    }
    ok('Pending approval reviews were listed over HTTP.')

    step('Fetch review package')
    const reviewResponse = await server.dispatch({
      method: 'GET',
      url: `/runs/${run.runId}/approval-review?viewerActorId=finance_viewer_http&viewerRole=finance&surface=external_api`,
      headers: {
        authorization: 'Bearer reviewer-token',
      },
    })
    if (reviewResponse.statusCode !== 200) {
      fail(`Expected review endpoint success, got ${reviewResponse.statusCode}.`)
    }
    const reviewBody = reviewResponse.body
    const review = reviewBody['review'] as Record<string, unknown> | undefined
    const reviewPackage = review?.['reviewPackage'] as Record<string, unknown> | undefined
    if (!reviewPackage?.['requirementId']) {
      fail('Expected requirementId in HTTP approval review payload.')
    }
    ok('Canonical approval review package was fetched over HTTP.')

    const spoofedReview = await server.dispatch({
      method: 'GET',
      url: `/runs/${run.runId}/approval-review?viewerActorId=other_viewer_http&viewerRole=finance&surface=external_api`,
      headers: {
        authorization: 'Bearer reviewer-token',
      },
    })
    if (spoofedReview.statusCode !== 403) {
      fail(`Expected 403 for spoofed viewer identity, got ${spoofedReview.statusCode}.`)
    }
    ok('Viewer identity spoofing was rejected.')

    step('Submit approvals through HTTP')
    const financeBody = {
      actor: {
        actorId: 'finance_approver_http',
        roleId: 'finance',
      },
      decision: 'approved',
      comment: 'Finance approval via HTTP transport.',
      externalEvidenceRef: 'approval-http://finance/decision-1',
      surface: 'external_api',
    }
    const financeTimestamp = new Date().toISOString()
    const financeDecision = await server.dispatch({
      method: 'POST',
      url: `/runs/${run.runId}/approval-decisions`,
      body: financeBody,
      headers: {
        'x-waos-key-id': 'finance-key',
        'x-waos-timestamp': financeTimestamp,
        'x-waos-signature': signWebhook({
          secret: 'finance-secret',
          timestamp: financeTimestamp,
          method: 'POST',
          url: `/runs/${run.runId}/approval-decisions`,
          body: financeBody,
        }),
      },
    })
    if (
      financeDecision.statusCode !== 200 ||
      financeDecision.body['outcome'] !== 'accepted'
    ) {
      fail(`Expected accepted finance approval via HTTP, got ${financeDecision.statusCode}.`)
    }
    ok('First approval submission succeeded over HTTP.')

    const spoofedDecisionBody = {
      actor: {
        actorId: 'spoofed_actor_http',
        roleId: 'finance',
      },
      decision: 'approved',
      comment: 'Spoofed approval should be rejected.',
      surface: 'external_api',
    }
    const spoofedTimestamp = new Date().toISOString()
    const spoofedDecision = await server.dispatch({
      method: 'POST',
      url: `/runs/${run.runId}/approval-decisions`,
      body: spoofedDecisionBody,
      headers: {
        'x-waos-key-id': 'finance-key',
        'x-waos-timestamp': spoofedTimestamp,
        'x-waos-signature': signWebhook({
          secret: 'finance-secret',
          timestamp: spoofedTimestamp,
          method: 'POST',
          url: `/runs/${run.runId}/approval-decisions`,
          body: spoofedDecisionBody,
        }),
      },
    })
    if (spoofedDecision.statusCode !== 403) {
      fail(`Expected 403 for spoofed approval actor, got ${spoofedDecision.statusCode}.`)
    }
    ok('Decision actor spoofing was rejected.')

    const complianceBody = {
      actor: {
        actorId: 'compliance_approver_http',
        roleId: 'compliance',
      },
      decision: 'approved',
      comment: 'Compliance approval via HTTP transport.',
      externalEvidenceRef: 'approval-http://compliance/decision-2',
      surface: 'external_api',
    }
    const complianceTimestamp = new Date().toISOString()
    const complianceDecision = await server.dispatch({
      method: 'POST',
      url: `/runs/${run.runId}/approval-decisions`,
      body: complianceBody,
      headers: {
        'x-waos-key-id': 'compliance-key',
        'x-waos-timestamp': complianceTimestamp,
        'x-waos-signature': signWebhook({
          secret: 'compliance-secret',
          timestamp: complianceTimestamp,
          method: 'POST',
          url: `/runs/${run.runId}/approval-decisions`,
          body: complianceBody,
        }),
      },
    })
    if (
      complianceDecision.statusCode !== 200 ||
      complianceDecision.body['outcome'] !== 'accepted'
    ) {
      fail(`Expected accepted compliance approval via HTTP, got ${complianceDecision.statusCode}.`)
    }
    ok('Second approval submission advanced the run over HTTP.')
  } finally {
    await kernel.closeSession(session.sessionId)
  }

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`${GREEN}${BOLD}Approval API HTTP checks passed.${RESET}\n`)
}

main().catch((error) => {
  console.error('\nFatal:', error)
  process.exit(1)
})
