/**
 * smoke-test-payment-batch.ts
 * Drives the kernel programmatically through a full treasury payment batch lifecycle.
 * Run: bun cli/smoke-test-payment-batch.ts
 */

import { bootstrap } from './bootstrap.js'

const RESET = '\x1b[0m'
const GREEN = '\x1b[32m'
const CYAN = '\x1b[36m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'

function step(label: string, detail?: string) {
  console.log(`\n${CYAN}${BOLD}▶ ${label}${RESET}${detail ? `  ${DIM}${detail}${RESET}` : ''}`)
}

function ok(msg: string) {
  console.log(`  ${GREEN}✓${RESET} ${msg}`)
}

function info(msg: string) {
  console.log(`  ${DIM}${msg}${RESET}`)
}

function fail(msg: string) {
  console.log(`  ${RED}✗ ${msg}${RESET}`)
  process.exit(1)
}

async function main() {
  console.log(`\n${BOLD}Wallet Agent OS — Payment Batch Smoke Test${RESET}`)
  console.log('─'.repeat(60))
  const sourceWalletId = `wallet_batch_smoke_source_${Date.now().toString(36)}`

  step('Bootstrap session')
  const { kernel, session } = await bootstrap({
    actorId: 'operator_1',
    organizationId: 'org_demo',
    persist: true,
    useDevPolicy: true,
  })
  ok(`Session: ${session.sessionId}`)

  step(
    'Send payment batch request',
    `2 USDC payouts from ${sourceWalletId} on base`,
  )
  const t1 = await kernel.handleInput({
    sessionId: session.sessionId,
    source: 'operator',
    text: 'run payment batch now',
    requestedActionType: 'treasury.payment_batch',
    payload: {
      treasuryId: 'treasury_main',
      sourceWalletId,
      chainId: 'base',
      assetSymbol: 'USDC',
      batchType: 'vendor',
      payments: [
        {
          destinationAddress: '0xVendor1000000000000000000000000000000001',
          amount: '250',
          counterpartyId: 'vendor_alpha',
          note: 'invoice_1001',
        },
        {
          destinationAddress: '0xVendor2000000000000000000000000000000002',
          amount: '300',
          counterpartyId: 'vendor_beta',
          note: 'invoice_1002',
        },
      ],
    },
  })

  for (const line of t1.output) info(line)

  if (!t1.createdRun || !t1.run) {
    fail(`Expected a run to be created. kind=${t1.kind}`)
  }

  const runId = t1.run.runId
  ok(`Run created: ${runId}`)
  info(`Phase: ${t1.run.currentPhase}  |  Status: ${t1.run.status}`)

  if (t1.run.status === 'failed') {
    fail('Run failed before signing.')
  }

  if (t1.run.status === 'waiting_for_approval') {
    step('Inject approval callback')
    await kernel.ingestCallback({
      type: 'approval_decision',
      runId,
      status: 'approved',
      approvalRecord: {
        approver: { actorId: 'operator_1', role: 'admin' },
        decidedAt: new Date().toISOString(),
        comment: 'Payment batch smoke test auto-approval.',
      },
    })
    ok('Approval injected')
  } else {
    info('Approval not required; continuing.')
  }

  step('Check run after approval gate')
  const afterApproval = await kernel.resumeRun(runId)
  info(`Phase: ${afterApproval.currentPhase}  |  Status: ${afterApproval.status}`)

  if (afterApproval.status === 'waiting_for_signature') {
    step('Inject signature callback')
    const fakeTxHash = `0x${'c'.repeat(64)}`
    const requestId =
      afterApproval.signatureRequestRefs.at(-1) ?? 'sigreq_batch_smoke'
    await kernel.ingestCallback({
      type: 'signature_status',
      runId,
      status: 'signed',
      signatureRequestId: requestId,
      transactionHash: fakeTxHash,
    })
    ok(`Signature injected  txHash: ${fakeTxHash}`)
  }

  step('Final run state')
  const finalRun = await kernel.resumeRun(runId)
  info(`Phase: ${finalRun.currentPhase}`)
  console.log(`  Status: ${finalRun.status === 'completed' ? GREEN : YELLOW}${BOLD}${finalRun.status}${RESET}`)

  if (finalRun.reportArtifactPath) {
    ok(`Report artifact: ${finalRun.reportArtifactPath}`)
  }

  if (finalRun.status !== 'completed') {
    fail(`Expected completed status, got ${finalRun.status}.`)
  }

  step('Close session')
  await kernel.closeSession(session.sessionId)
  ok('Session closed')

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`${GREEN}${BOLD}Payment batch flow completed successfully.${RESET}\n`)
}

main().catch((err) => {
  console.error('\nFatal:', err)
  process.exit(1)
})
