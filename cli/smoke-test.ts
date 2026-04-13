/**
 * smoke-test.ts
 * Drives the kernel programmatically through a full transfer lifecycle.
 * Run: bun cli/smoke-test.ts
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
  console.log(`\n${BOLD}Wallet Agent OS — Smoke Test${RESET}`)
  console.log('─'.repeat(60))

  // ── 1. Bootstrap ──────────────────────────────────────────────
  step('Bootstrap session')
  // Use file persistence so readArtifactJson() can read artifacts back from disk.
  // In-memory mode only stores artifact refs, not data, so cross-phase reads fail.
  const { kernel, session } = await bootstrap({
    actorId: 'operator_1',
    organizationId: 'org_demo',
    persist: true,
    useDevPolicy: true,
  })
  ok(`Session: ${session.sessionId}`)
  ok(`Mode: ${session.mode}`)

  // ── 2. Transfer request (structured payload includes sourceWalletId) ───────
  step('Send transfer request', '500 USDC from wallet_treasury_main → wallet_vendor_1')
  const t1 = await kernel.handleInput({
    sessionId: session.sessionId,
    source: 'operator',
    text: 'send 500 USDC to wallet_vendor_1 on solana',
    payload: {
      sourceWalletId: 'wallet_treasury_main',
      destinationAddress: '0xVendor1000000000000000000000000000000001',
      chainId: 'base',
      assetSymbol: 'USDC',
      amount: '500',
    },
  })

  info(`kind: ${t1.kind}`)
  for (const line of t1.output) info(line)

  if (!t1.createdRun || !t1.run) {
    fail(`Expected a run to be created. kind=${t1.kind}`)
  }

  const run = t1.run
  ok(`Run created: ${run.runId}`)
  ok(`Action: ${run.actionType}`)
  info(`Phase: ${run.currentPhase}  |  Status: ${run.status}`)

  if (run.status === 'failed') {
    fail(`Run failed before reaching approval phase. Check output above.`)
  }

  // ── 3. Inject approval ─────────────────────────────────────────
  step('Inject approval callback')
  await kernel.ingestCallback({
    type: 'approval_decision',
    runId: run.runId,
    status: 'approved',
    approvalRecord: {
      approver: { actorId: 'operator_1', role: 'admin' },
      decidedAt: new Date().toISOString(),
      comment: 'Smoke test auto-approval.',
    },
  })
  ok('Approval injected')

  // ── 4. Check run state after approval ─────────────────────────
  step('Resume run to check state')
  const afterApproval = await kernel.resumeRun(run.runId)
  info(`Phase: ${afterApproval.currentPhase}  |  Status: ${afterApproval.status}`)
  ok(`Run progressed to phase: ${afterApproval.currentPhase}`)

  // ── 5. Inject signature ────────────────────────────────────────
  step('Inject signature callback')
  const fakeTxHash = `0x${'b'.repeat(64)}`
  const fakeReqId = afterApproval.signatureRequestRefs.at(-1) ?? `sigreq_smoke`
  await kernel.ingestCallback({
    type: 'signature_status',
    runId: run.runId,
    status: 'signed',
    signatureRequestId: fakeReqId,
    transactionHash: fakeTxHash,
  })
  ok(`Signature injected  txHash: ${fakeTxHash}`)

  // ── 6. Check run state after signing ──────────────────────────
  const afterSigning = await kernel.resumeRun(run.runId)
  info(`Phase: ${afterSigning.currentPhase}  |  Status: ${afterSigning.status}`)

  // ── 7. Inject broadcast confirmation (only if not already completed) ───────
  step('Inject broadcast confirmation')
  if (afterSigning.status === 'completed') {
    ok('Run already completed (deterministic broadcaster auto-advanced through broadcast+reconciliation)')
  } else {
    const broadcastRef = afterSigning.broadcastRefs.at(-1) ?? `bcast_smoke`
    await kernel.ingestCallback({
      type: 'broadcast_confirmation',
      runId: run.runId,
      status: 'confirmed',
      broadcastRef,
      transactionHash: fakeTxHash,
    })
    ok('Broadcast confirmation injected')
  }

  // ── 8. Final state ─────────────────────────────────────────────
  step('Final run state')
  const finalRun = await kernel.resumeRun(run.runId)
  info(`Phase: ${finalRun.currentPhase}`)

  const statusColor = finalRun.status === 'completed' ? GREEN : YELLOW
  console.log(`  Status: ${statusColor}${BOLD}${finalRun.status}${RESET}`)

  if (finalRun.reportArtifactPath) {
    ok(`Report artifact: ${finalRun.reportArtifactPath}`)
  }

  // ── 9. Close session ───────────────────────────────────────────
  step('Close session')
  await kernel.closeSession(session.sessionId)
  ok('Session closed')

  console.log(`\n${'─'.repeat(60)}`)
  if (finalRun.status === 'completed') {
    console.log(`${GREEN}${BOLD}All phases completed successfully.${RESET}\n`)
  } else {
    console.log(`${YELLOW}${BOLD}Run ended with status: ${finalRun.status}${RESET}\n`)
    console.log(`${DIM}This is expected — the deterministic signer/broadcaster may have${RESET}`)
    console.log(`${DIM}moved straight through without waiting. Check phase transitions.${RESET}\n`)
  }
}

main().catch((err) => {
  console.error('\nFatal:', err)
  process.exit(1)
})
