import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js'
import type { KernelTurnResult, RunState, SessionState } from '../../src/contracts/runtime.js'
import type { SessionKernel } from '../../src/contracts/runtime.js'
import type { WalletRecord } from '../../src/contracts/wallet.js'
import type { RunRegistry } from '../../src/runtime/runRegistry.js'
import type { WalletRegistry } from '../../src/wallets/WalletRegistry.js'
import type { KernelPersistence } from '../../src/runtime/kernelPersistence.js'

export type CommandSpec = {
  command: string
  description: string
  requiresArgs?: boolean
}

export const COMMANDS: CommandSpec[] = [
  { command: '/status', description: 'Show current session and last run state.' },
  { command: '/wallets', description: 'Browse wallets for this organization.' },
  { command: '/approve [runId]', description: 'Approve the latest pending run or a specific run.', requiresArgs: true },
  { command: '/reject [runId]', description: 'Reject the latest pending run or a specific run.', requiresArgs: true },
  { command: '/approvalpkg [runId]', description: 'Show approval review package path and summary.', requiresArgs: true },
  { command: '/pendingcompliance', description: 'List wallets waiting on KYC or KYB.' },
  { command: '/compliance <walletId|subjectId>', description: 'Inspect compliance state for one wallet.', requiresArgs: true },
  { command: '/breakglass [runId] <reason>', description: 'Submit a break-glass approval decision.', requiresArgs: true },
  { command: '/sign [runId]', description: 'Inject a signature callback for a run.', requiresArgs: true },
  { command: '/confirm [runId] [txHash]', description: 'Inject a broadcast confirmation callback.', requiresArgs: true },
  { command: '/resume [runId]', description: 'Resume a waiting run.', requiresArgs: true },
  { command: '/halt [runId]', description: 'Halt a run manually.', requiresArgs: true },
  { command: '/help', description: 'Show available commands.' },
  { command: '/quit', description: 'Exit the terminal.' },
]

type Props = {
  kernel: SessionKernel
  session: SessionState
  persist: boolean
  runsDir: string | null
  persistence: KernelPersistence
  runRegistry: RunRegistry
  walletRegistry: WalletRegistry
  solanaMeta?: { cluster: string; walletAddress: string; keypairSource?: string }
  solanaRpcUrl?: string
}

type TranscriptTone = 'accent' | 'success' | 'warning' | 'error' | 'info'

type TranscriptEntry = {
  id: string
  title: string
  lines: string[]
  tone?: TranscriptTone
}

type ApprovalOverlay = {
  type: 'approval'
  runId: string
  summary: string
  selectedIndex: number
}

type WalletBrowserOverlay = {
  type: 'wallet_browser'
  wallets: WalletRecord[]
  query: string
  selectedIndex: number
}

type WalletDetailOverlay = {
  type: 'wallet_detail'
  title: string
  lines: string[]
}

type OverlayState = ApprovalOverlay | WalletBrowserOverlay | WalletDetailOverlay | null

let nextEntryId = 0

function createEntry(title: string, lines: string[], tone: TranscriptTone = 'info'): TranscriptEntry {
  nextEntryId += 1
  return {
    id: `entry_${nextEntryId}`,
    title,
    lines,
    tone,
  }
}

function toneColor(tone: TranscriptTone): string {
  switch (tone) {
    case 'success':
      return 'green'
    case 'warning':
      return 'yellow'
    case 'error':
      return 'red'
    case 'accent':
      return 'cyan'
    default:
      return 'blue'
  }
}

function Panel({ title, lines, tone = 'info' }: { title: string; lines: string[]; tone?: TranscriptTone }) {
  return (
    <Box borderStyle="round" borderColor={toneColor(tone)} paddingX={1} paddingY={0} flexDirection="column">
      <Text bold color={toneColor(tone)}>{title}</Text>
      {lines.map((line, index) => (
        <Text key={`${title}_${index}`} color="white">{line}</Text>
      ))}
    </Box>
  )
}

function Header({
  sessionId,
  persist,
  runsDir,
  solanaMeta,
}: {
  sessionId: string
  persist: boolean
  runsDir: string | null
  solanaMeta?: { cluster: string; walletAddress: string; keypairSource?: string }
}) {
  return (
    <Panel
      title="Wallet Agent OS — Operator Terminal"
      tone="accent"
      lines={[
        `Session   ${sessionId}`,
        `Storage   ${persist ? `file-backed  ${runsDir}` : 'in-memory'}`,
        solanaMeta
          ? `Mode      Solana ${solanaMeta.cluster}  |  signer ${solanaMeta.walletAddress}`
          : 'Mode      deterministic adapters',
        ...(solanaMeta?.keypairSource ? [`Signer    ${solanaMeta.keypairSource}`] : []),
        'Hint      Type freeform text or start with / to filter commands.',
      ]}
    />
  )
}

function PromptLine({ value, cursor, placeholder, busy }: { value: string; cursor: number; placeholder: string; busy: boolean }) {
  const before = value.slice(0, cursor)
  const current = value[cursor] ?? ' '
  const after = value.slice(cursor + (cursor < value.length ? 1 : 0))
  const showPlaceholder = value.length === 0

  return (
    <Box flexDirection="row">
      <Text bold color="magenta">you</Text>
      <Text color="gray"> › </Text>
      {showPlaceholder ? (
        <>
          <Text dimColor>{placeholder}</Text>
          <Text inverse={!busy}> </Text>
        </>
      ) : (
        <>
          <Text>{before}</Text>
          <Text inverse={!busy}>{current}</Text>
          <Text>{after}</Text>
        </>
      )}
    </Box>
  )
}

function StatusBar({
  sessionId,
  lastRunId,
  busyLabel,
  overlay,
}: {
  sessionId: string
  lastRunId?: string
  busyLabel: string | null
  overlay: OverlayState
}) {
  const overlayLabel = overlay?.type === 'wallet_browser'
    ? 'wallet browser'
    : overlay?.type === 'wallet_detail'
      ? 'wallet details'
      : overlay?.type === 'approval'
        ? 'approval review'
        : 'none'

  return (
    <Box justifyContent="space-between">
      <Text dimColor>{`session ${sessionId}`}</Text>
      <Text dimColor>{lastRunId ? `last run ${lastRunId}` : 'no runs yet'}</Text>
      <Text dimColor>{busyLabel ?? `overlay ${overlayLabel}`}</Text>
    </Box>
  )
}

function SuggestionList({
  specs,
  selectedIndex,
}: {
  specs: CommandSpec[]
  selectedIndex: number
}) {
  return (
    <Panel
      title="Commands"
      tone="accent"
      lines={specs.slice(0, 6).map((spec, index) => {
        const prefix = index === selectedIndex ? '›' : ' '
        return `${prefix} ${spec.command}  ${spec.description}`
      })}
    />
  )
}

function WalletBrowser({
  wallets,
  query,
  selectedIndex,
}: {
  wallets: WalletRecord[]
  query: string
  selectedIndex: number
}) {
  const visible = wallets.slice(0, 8)
  return (
    <Panel
      title="Wallets"
      tone="accent"
      lines={[
        `Filter    ${query || 'type to narrow'}`,
        ...(
          visible.length > 0
            ? visible.map((wallet, index) => {
                const prefix = index === selectedIndex ? '›' : ' '
                return `${prefix} ${wallet.walletId}  ${wallet.subjectId ?? 'unknown'}  |  ${wallet.walletType ?? 'unknown'}  |  ${wallet.state}  |  trust ${wallet.trustStatus}`
              })
            : ['No wallets match this filter.']
        ),
        '↑↓ move  Enter inspect  Esc cancel',
      ]}
    />
  )
}

function ApprovalReview({ runId, summary, selectedIndex }: { runId: string; summary: string; selectedIndex: number }) {
  const options = [
    'Approve and advance the run into signing.',
    'Reject and fail the run safely.',
  ]

  return (
    <Panel
      title="Approval Required"
      tone="warning"
      lines={[
        `Run       ${runId}`,
        `Action    ${summary}`,
        '',
        ...options.map((option, index) => `${index === selectedIndex ? '›' : ' '} ${index === 0 ? 'Approve' : 'Reject'}  ${option}`),
        '↑↓ move  Enter decide  Esc defer',
      ]}
    />
  )
}

function exactCommandName(input: string): string | undefined {
  const commandToken = input.trim().split(/\s+/)[0]
  return COMMANDS.find((command) => command.command.split(' ')[0] === commandToken)?.command.split(' ')[0]
}

export function OperatorCliApp({
  kernel,
  session,
  persist,
  runsDir,
  persistence,
  runRegistry,
  walletRegistry,
  solanaMeta,
  solanaRpcUrl,
}: Props) {
  const { exit } = useApp()
  const [input, setInput] = useState('')
  const [cursor, setCursor] = useState(0)
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([
    createEntry('Ready', [
      'Natural language routing is live.',
      'Slash commands filter inline as you type.',
      'Use /wallets to inspect wallet state without leaving the terminal.',
    ], 'accent'),
  ])
  const [lastRunId, setLastRunId] = useState<string | undefined>()
  const [overlay, setOverlay] = useState<OverlayState>(null)
  const [busyLabel, setBusyLabel] = useState<string | null>(null)
  const [commandSelection, setCommandSelection] = useState(0)
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [historyDraft, setHistoryDraft] = useState('')
  const isMountedRef = useRef(true)

  useEffect(() => {
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const appendEntries = useCallback((entries: TranscriptEntry[]) => {
    setTranscript((current) => [...current, ...entries])
  }, [])

  const appendEntry = useCallback((entry: TranscriptEntry) => {
    appendEntries([entry])
  }, [appendEntries])

  const appendError = useCallback((message: string) => {
    appendEntry(createEntry('Error', [message], 'error'))
  }, [appendEntry])

  const resetInput = useCallback(() => {
    setInput('')
    setCursor(0)
    setHistoryIndex(null)
  }, [])

  const commandSuggestions = useMemo(() => {
    if (!input.startsWith('/')) {
      return []
    }

    const query = input.slice(1).trim().toLowerCase()
    if (!query) {
      return COMMANDS
    }

    return COMMANDS.filter((spec) => {
      const name = spec.command.toLowerCase()
      const description = spec.description.toLowerCase()
      return name.includes(query) || description.includes(query)
    })
  }, [input])

  useEffect(() => {
    setCommandSelection((current) => {
      if (commandSuggestions.length === 0) {
        return 0
      }
      return Math.max(0, Math.min(current, commandSuggestions.length - 1))
    })
  }, [commandSuggestions])

  const buildApprovalRecord = useCallback((comment: string) => ({
    approver: {
      actorId: session.actorContext.actorId,
      role: session.actorContext.roleIds[0] ?? 'operator',
    },
    decidedAt: new Date().toISOString(),
    comment,
  }), [session.actorContext.actorId, session.actorContext.roleIds])

  const getOrgWallets = useCallback(async (): Promise<WalletRecord[]> => {
    const orgId = session.orgContext.organizationId
    const wallets = orgId
      ? await walletRegistry.listByOrganization(orgId)
      : await walletRegistry.list()
    return wallets.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }, [session.orgContext.organizationId, walletRegistry])

  const getWalletPendingRuns = useCallback(async (walletId: string): Promise<RunState[]> => {
    const candidateRuns = (await runRegistry.listBySession(session.sessionId))
      .filter((run) => !['completed', 'failed', 'halted'].includes(run.status))

    const pending: RunState[] = []
    for (const run of candidateRuns) {
      const events = await persistence.ledger.listForRun(run.runId)
      if (events.some((event) => event.refs.walletIds?.includes(walletId))) {
        pending.push(run)
      }
    }

    return pending.sort((left, right) => right.lastUpdatedAt.localeCompare(left.lastUpdatedAt))
  }, [persistence.ledger, runRegistry, session.sessionId])

  const getWalletBalanceSummary = useCallback(async (wallet: WalletRecord): Promise<string> => {
    if (!wallet.address) {
      return 'Address not available.'
    }
    if (!solanaMeta) {
      return 'Balance lookup is available in Solana CLI mode only.'
    }

    try {
      const connection = new Connection(
        solanaRpcUrl ?? clusterApiUrl(solanaMeta.cluster as 'devnet' | 'mainnet-beta' | 'testnet'),
        'confirmed',
      )
      const lamports = await connection.getBalance(new PublicKey(wallet.address))
      return `${(lamports / 1_000_000_000).toFixed(4)} SOL`
    } catch {
      return 'Unavailable for this address on the active Solana cluster.'
    }
  }, [solanaMeta, solanaRpcUrl])

  const buildHelpEntry = useCallback(() => {
    const lines = COMMANDS.map((item) => `${item.command}  ${item.description}`)
    lines.push('')
    lines.push('Examples')
    lines.push('create a payout wallet for contractor Javier')
    lines.push('pay 2 vendors 300 and 250 USDC from wallet_batch_smoke_source on base')
    lines.push('what runs are pending?')
    return createEntry('Commands', lines, 'accent')
  }, [])

  const buildSessionEntry = useCallback(() => createEntry('Session', [
    `Session   ${session.sessionId}`,
    lastRunId ? `Last Run  ${lastRunId}` : 'Last Run  none',
  ], 'info'), [lastRunId, session.sessionId])

  const buildTurnEntries = useCallback((result: KernelTurnResult): TranscriptEntry[] => {
    const entries: TranscriptEntry[] = []
    const rows = [
      ...(result.createdRun && result.run
        ? [
            `New Run   ${result.run.runId}`,
            `Action    ${result.run.actionType}`,
            '',
          ]
        : []),
      ...result.output,
    ]
    entries.push(createEntry('Result', rows, 'accent'))

    if (result.run) {
      const run = result.run
      const tone: TranscriptTone =
        run.status === 'completed' ? 'success'
        : run.status === 'failed' || run.status === 'halted' ? 'error'
        : run.status.startsWith('waiting') ? 'warning'
        : 'info'
      entries.push(createEntry('Run State', [
        `Run       ${run.runId}`,
        `Phase     ${run.currentPhase}`,
        `Status    ${run.status}`,
        ...(run.approvalStateRef ? [`Approval  ${run.approvalStateRef}`] : []),
        ...(run.signatureRequestRefs.length > 0 ? [`Sig Reqs  ${run.signatureRequestRefs.join(', ')}`] : []),
        ...(run.broadcastRefs.length > 0 ? [`Broadcast ${run.broadcastRefs.join(', ')}`] : []),
      ], tone))
    }

    return entries
  }, [])

  const buildRunEntries = useCallback((run: RunState): TranscriptEntry[] => {
    const tone: TranscriptTone =
      run.status === 'completed' ? 'success'
      : run.status === 'failed' || run.status === 'halted' ? 'error'
      : run.status.startsWith('waiting') ? 'warning'
      : 'info'

    return [createEntry('Run State', [
      `Run       ${run.runId}`,
      `Phase     ${run.currentPhase}`,
      `Status    ${run.status}`,
      ...(run.approvalStateRef ? [`Approval  ${run.approvalStateRef}`] : []),
      ...(run.signatureRequestRefs.length > 0 ? [`Sig Reqs  ${run.signatureRequestRefs.join(', ')}`] : []),
      ...(run.broadcastRefs.length > 0 ? [`Broadcast ${run.broadcastRefs.join(', ')}`] : []),
    ], tone)]
  }, [])

  const handleExit = useCallback(async () => {
    setBusyLabel('closing session')
    try {
      await kernel.closeSession(session.sessionId)
    } finally {
      exit()
    }
  }, [exit, kernel, session.sessionId])

  const executeApprovalDecision = useCallback(async (
    status: 'approved' | 'rejected',
    runId?: string,
    breakGlassReason?: string,
  ) => {
    setBusyLabel(status === 'approved' ? 'submitting approval' : 'submitting rejection')
    try {
      if (runId) {
        await kernel.ingestCallback({
          type: 'approval_decision',
          runId,
          status,
          breakGlassReason,
          approvalRecord: buildApprovalRecord(
            breakGlassReason
              ? `Break-glass ${status} via CLI: ${breakGlassReason}`
              : `${status} via CLI.`,
          ),
        })
        const updatedRun = await runRegistry.get(runId)
        if (updatedRun) {
          setLastRunId(updatedRun.runId)
          appendEntry(createEntry('Approval', [`${status} decision submitted for ${runId}.`], status === 'approved' ? 'success' : 'warning'))
          appendEntries(buildRunEntries(updatedRun))
        } else {
          appendEntry(createEntry('Approval', [`${status} decision submitted for ${runId}.`], status === 'approved' ? 'success' : 'warning'))
        }
      } else {
        const result = await kernel.handleInput({
          sessionId: session.sessionId,
          source: 'operator',
          kind: 'operator_command',
          payload: { command: status === 'approved' ? 'approve' : 'reject' },
        })
        appendEntries(buildTurnEntries(result))
        if (result.run) {
          setLastRunId(result.run.runId)
        }
      }
    } finally {
      if (isMountedRef.current) {
        setBusyLabel(null)
      }
    }
  }, [appendEntries, appendEntry, buildApprovalRecord, buildTurnEntries, kernel, runRegistry, session.sessionId])

  const openWalletBrowser = useCallback(async () => {
    setBusyLabel('loading wallets')
    try {
      const wallets = await getOrgWallets()
      if (wallets.length === 0) {
        appendError('No wallets found for this organization yet.')
        return
      }
      setOverlay({
        type: 'wallet_browser',
        wallets,
        query: '',
        selectedIndex: 0,
      })
    } finally {
      if (isMountedRef.current) {
        setBusyLabel(null)
      }
    }
  }, [appendError, getOrgWallets])

  const openWalletDetail = useCallback(async (wallet: WalletRecord) => {
    setBusyLabel(`loading ${wallet.walletId}`)
    try {
      const pendingRuns = await getWalletPendingRuns(wallet.walletId)
      const balance = await getWalletBalanceSummary(wallet)
      const detailLines = [
        `Wallet      ${wallet.walletId}`,
        `Subject     ${wallet.subjectId ?? 'unknown'}`,
        `Type        ${wallet.walletType ?? 'unknown'}`,
        `State       ${wallet.state}`,
        `Address     ${wallet.address ?? 'none'}`,
        `Balance     ${balance}`,
        `Compliance  ${wallet.complianceStatus}`,
        `Workflow    ${wallet.complianceWorkflowId ?? 'none'}`,
        `Provider    ${wallet.complianceProviderId ?? wallet.providerId ?? 'none'}`,
        `Trust       ${wallet.trustStatus}`,
        `Signer      ${wallet.signerProfileId ?? 'none'}`,
        `Policy      ${wallet.policyAttachmentStatus}`,
        `Pending     ${pendingRuns.length > 0 ? pendingRuns.map((run) => `${run.runId} (${run.status})`).join(', ') : 'none'}`,
        `Updated     ${wallet.updatedAt}`,
      ]
      setOverlay({
        type: 'wallet_detail',
        title: 'Wallet Details',
        lines: detailLines,
      })
    } finally {
      if (isMountedRef.current) {
        setBusyLabel(null)
      }
    }
  }, [getWalletBalanceSummary, getWalletPendingRuns])

  const executeLine = useCallback(async (rawInput: string) => {
    const trimmed = rawInput.trim()
    const normalized = trimmed.startsWith('/') ? trimmed.replace(/^\/+/, '/') : trimmed
    if (!normalized) {
      return
    }

    appendEntry(createEntry('Input', [normalized], 'info'))

    if (normalized === '/quit' || normalized === '/exit') {
      await handleExit()
      return
    }

    if (normalized === '/help') {
      appendEntry(buildHelpEntry())
      return
    }

    if (normalized === '/status') {
      appendEntry(buildSessionEntry())
      return
    }

    if (normalized === '/wallets') {
      await openWalletBrowser()
      return
    }

    if (normalized === '/pendingcompliance') {
      const result = await kernel.handleInput({
        sessionId: session.sessionId,
        source: 'operator',
        kind: 'operator_command',
        payload: { command: 'pending_compliance' },
      })
      appendEntries(buildTurnEntries(result))
      if (result.run) {
        setLastRunId(result.run.runId)
      }
      return
    }

    const complianceMatch = normalized.match(/^\/compliance(?:\s+(.+))?$/)
    if (complianceMatch) {
      const target = complianceMatch[1]?.trim()
      if (!target) {
        appendError('Usage: /compliance <walletId|subjectId>')
        return
      }
      const result = await kernel.handleInput({
        sessionId: session.sessionId,
        source: 'operator',
        kind: 'operator_command',
        payload: { command: 'compliance_status', target },
      })
      appendEntries(buildTurnEntries(result))
      if (result.run) {
        setLastRunId(result.run.runId)
      }
      return
    }

    const approveMatch = normalized.match(/^\/approve(?:\s+(\S+))?$/)
    if (approveMatch) {
      await executeApprovalDecision('approved', approveMatch[1])
      return
    }

    const rejectMatch = normalized.match(/^\/reject(?:\s+(\S+))?$/)
    if (rejectMatch) {
      await executeApprovalDecision('rejected', rejectMatch[1])
      return
    }

    const breakGlassMatch = normalized.match(/^\/breakglass(?:\s+(\S+))?(?:\s+(.+))?$/)
    if (breakGlassMatch) {
      const runId = breakGlassMatch[1] ?? lastRunId
      const reason = breakGlassMatch[2]?.trim()
      if (!runId) {
        appendError('No run ID.')
        return
      }
      if (!reason) {
        appendError('Break-glass requires a reason. Usage: /breakglass [runId] <reason>')
        return
      }
      await executeApprovalDecision('approved', runId, reason)
      return
    }

    const approvalPackageMatch = normalized.match(/^\/approvalpkg(?:\s+(\S+))?$/)
    if (approvalPackageMatch) {
      const runId = approvalPackageMatch[1] ?? lastRunId
      if (!runId) {
        appendError('No run ID. Pass /approvalpkg <runId> or run a request first.')
        return
      }
      const result = await kernel.handleInput({
        sessionId: session.sessionId,
        source: 'operator',
        kind: 'operator_command',
        runId,
        payload: { command: 'approval_package' },
      })
      appendEntries(buildTurnEntries(result))
      if (result.run) {
        setLastRunId(result.run.runId)
      }
      return
    }

    const signMatch = normalized.match(/^\/sign(?:\s+(\S+))?$/)
    if (signMatch) {
      const runId = signMatch[1] ?? lastRunId
      if (!runId) {
        appendError('No run ID.')
        return
      }
      const fakeReqId = `sigreq_${Date.now().toString(36)}`
      const fakeTxHash = `0x${Buffer.from(runId).toString('hex').slice(0, 64).padEnd(64, '0')}`
      await kernel.ingestCallback({
        type: 'signature_status',
        runId,
        status: 'signed',
        signatureRequestId: fakeReqId,
        transactionHash: fakeTxHash,
      })
      const run = await runRegistry.get(runId)
      appendEntry(createEntry('Signature Injected', [
        `Run      ${runId}`,
        `Tx Hash  ${fakeTxHash}`,
      ], 'success'))
      if (run) {
        setLastRunId(run.runId)
        appendEntries(buildRunEntries(run))
      }
      return
    }

    const confirmMatch = normalized.match(/^\/confirm(?:\s+(\S+))?(?:\s+(\S+))?$/)
    if (confirmMatch) {
      const runId = confirmMatch[1] ?? lastRunId
      const txHash = confirmMatch[2] ?? `0x${'a'.repeat(64)}`
      if (!runId) {
        appendError('No run ID.')
        return
      }
      const broadcastRef = `bcast_${Date.now().toString(36)}`
      await kernel.ingestCallback({
        type: 'broadcast_confirmation',
        runId,
        status: 'confirmed',
        broadcastRef,
        transactionHash: txHash,
      })
      const run = await runRegistry.get(runId)
      appendEntry(createEntry('Broadcast Confirmed', [
        `Run        ${runId}`,
        `Broadcast  ${broadcastRef}`,
        `Tx Hash    ${txHash}`,
      ], 'success'))
      if (run) {
        setLastRunId(run.runId)
        appendEntries(buildRunEntries(run))
      }
      return
    }

    const resumeMatch = normalized.match(/^\/resume(?:\s+(\S+))?$/)
    if (resumeMatch) {
      const runId = resumeMatch[1] ?? lastRunId
      if (!runId) {
        appendError('No run ID.')
        return
      }
      const run = await kernel.resumeRun(runId)
      setLastRunId(run.runId)
      appendEntries(buildRunEntries(run))
      return
    }

    const haltMatch = normalized.match(/^\/halt(?:\s+(\S+))?$/)
    if (haltMatch) {
      const runId = haltMatch[1] ?? lastRunId
      if (!runId) {
        appendError('No run ID.')
        return
      }
      await kernel.haltRun(runId, 'Halted by operator via CLI.')
      const run = await runRegistry.get(runId)
      appendEntry(createEntry('Run Halted', [`${runId} halted by operator.`], 'warning'))
      if (run) {
        setLastRunId(run.runId)
        appendEntries(buildRunEntries(run))
      }
      return
    }

    if (normalized.startsWith('/')) {
      appendError(`Unknown command: ${normalized}. Keep typing to filter or use /help.`)
      return
    }

    const solanaPayload = solanaMeta
      ? { sourceWalletId: solanaMeta.walletAddress }
      : undefined

    const result = await kernel.handleInput({
      sessionId: session.sessionId,
      source: 'operator',
      text: normalized,
      payload: solanaPayload,
    })

    appendEntries(buildTurnEntries(result))
    if (!result.run) {
      return
    }

    setLastRunId(result.run.runId)

    if (result.run.status === 'waiting_for_approval') {
      setOverlay({
        type: 'approval',
        runId: result.run.runId,
        summary: `${result.run.actionType} — run ${result.run.runId}`,
        selectedIndex: 0,
      })
    }
  }, [
    appendEntries,
    appendEntry,
    appendError,
    buildHelpEntry,
    buildRunEntries,
    buildSessionEntry,
    buildTurnEntries,
    executeApprovalDecision,
    handleExit,
    kernel,
    lastRunId,
    openWalletBrowser,
    runRegistry,
    session.sessionId,
    solanaMeta,
  ])

  const submitInput = useCallback(async () => {
    if (busyLabel) {
      return
    }

    const trimmed = input.trim()
    if (!trimmed) {
      return
    }

    const selectedCommand = commandSuggestions[commandSelection]
    const exact = exactCommandName(trimmed)
    const isSingleCommandToken = trimmed.startsWith('/') && trimmed.split(/\s+/).length === 1

    let commandText = trimmed
    if (selectedCommand && isSingleCommandToken && !exact) {
      const selectedName = selectedCommand.command.split(' ')[0]!
      if (selectedCommand.requiresArgs) {
        setInput(`${selectedName} `)
        setCursor(selectedName.length + 1)
        return
      }
      commandText = selectedName
    }

    setHistory((current) => (current[current.length - 1] === commandText ? current : [...current, commandText]))
    setHistoryIndex(null)
    setHistoryDraft('')
    resetInput()
    setBusyLabel(`processing ${commandText}`)

    try {
      await executeLine(commandText)
    } catch (error) {
      appendError(String(error))
    } finally {
      if (isMountedRef.current) {
        setBusyLabel(null)
      }
    }
  }, [appendError, busyLabel, commandSelection, commandSuggestions, executeLine, input, resetInput])

  useInput((keyInput, key) => {
    if (key.ctrl && keyInput === 'c') {
      void handleExit()
      return
    }

    if (busyLabel) {
      return
    }

    if (overlay?.type === 'wallet_detail') {
      if (key.return || key.escape) {
        setOverlay(null)
      }
      return
    }

    if (overlay?.type === 'approval') {
      if (key.upArrow || key.leftArrow) {
        setOverlay({ ...overlay, selectedIndex: Math.max(0, overlay.selectedIndex - 1) })
        return
      }
      if (key.downArrow || key.rightArrow) {
        setOverlay({ ...overlay, selectedIndex: Math.min(1, overlay.selectedIndex + 1) })
        return
      }
      if (key.escape) {
        setOverlay(null)
        appendEntry(createEntry('Approval Deferred', [`Run ${overlay.runId} remains waiting for approval.`], 'warning'))
        return
      }
      if (key.return) {
        const decision = overlay.selectedIndex === 0 ? 'approved' : 'rejected'
        setOverlay(null)
        void executeApprovalDecision(decision, overlay.runId)
      }
      return
    }

    if (overlay?.type === 'wallet_browser') {
      const filtered = overlay.wallets.filter((wallet) => {
        const haystack = `${wallet.walletId} ${wallet.subjectId ?? ''} ${wallet.walletType ?? ''} ${wallet.state} ${wallet.trustStatus}`.toLowerCase()
        return haystack.includes(overlay.query.toLowerCase())
      })

      if (key.escape) {
        setOverlay(null)
        return
      }
      if (key.upArrow) {
        setOverlay({ ...overlay, selectedIndex: Math.max(0, overlay.selectedIndex - 1) })
        return
      }
      if (key.downArrow) {
        setOverlay({ ...overlay, selectedIndex: Math.min(Math.max(filtered.length - 1, 0), overlay.selectedIndex + 1) })
        return
      }
      if (key.backspace || key.delete) {
        const nextQuery = overlay.query.slice(0, -1)
        setOverlay({ ...overlay, query: nextQuery, selectedIndex: 0 })
        return
      }
      if (key.return) {
        const wallet = filtered[overlay.selectedIndex]
        if (wallet) {
          void openWalletDetail(wallet)
        }
        return
      }
      if (!key.ctrl && !key.meta && keyInput && keyInput >= ' ') {
        setOverlay({ ...overlay, query: overlay.query + keyInput, selectedIndex: 0 })
      }
      return
    }

    if (key.escape) {
      resetInput()
      return
    }

    if (key.return) {
      void submitInput()
      return
    }

    if (key.tab && commandSuggestions.length > 0) {
      const selected = commandSuggestions[commandSelection]
      if (!selected) {
        return
      }
      const selectedName = selected.command.split(' ')[0]!
      const nextValue = selected.requiresArgs ? `${selectedName} ` : selectedName
      setInput(nextValue)
      setCursor(nextValue.length)
      return
    }

    if (key.upArrow) {
      if (commandSuggestions.length > 0 && input.startsWith('/')) {
        setCommandSelection((current) => Math.max(0, current - 1))
        return
      }

      setHistoryIndex((current) => {
        if (history.length === 0) {
          return null
        }
        const nextIndex = current === null ? history.length - 1 : Math.max(0, current - 1)
        if (current === null) {
          setHistoryDraft(input)
        }
        const nextValue = history[nextIndex] ?? ''
        setInput(nextValue)
        setCursor(nextValue.length)
        return nextIndex
      })
      return
    }

    if (key.downArrow) {
      if (commandSuggestions.length > 0 && input.startsWith('/')) {
        setCommandSelection((current) => Math.min(commandSuggestions.length - 1, current + 1))
        return
      }

      setHistoryIndex((current) => {
        if (current === null) {
          return null
        }
        const nextIndex = current + 1
        if (nextIndex >= history.length) {
          setInput(historyDraft)
          setCursor(historyDraft.length)
          return null
        }
        const nextValue = history[nextIndex] ?? ''
        setInput(nextValue)
        setCursor(nextValue.length)
        return nextIndex
      })
      return
    }

    if (key.leftArrow) {
      setCursor((current) => Math.max(0, current - 1))
      return
    }

    if (key.rightArrow) {
      setCursor((current) => Math.min(input.length, current + 1))
      return
    }

    if (key.backspace) {
      if (cursor === 0) {
        return
      }
      const nextValue = input.slice(0, cursor - 1) + input.slice(cursor)
      setInput(nextValue)
      setCursor(cursor - 1)
      setHistoryIndex(null)
      return
    }

    if (key.delete) {
      const nextValue = input.slice(0, cursor) + input.slice(cursor + 1)
      setInput(nextValue)
      setHistoryIndex(null)
      return
    }

    if (!key.ctrl && !key.meta && keyInput && keyInput >= ' ') {
      const nextValue = input.slice(0, cursor) + keyInput + input.slice(cursor)
      setInput(nextValue)
      setCursor(cursor + keyInput.length)
      setHistoryIndex(null)
    }
  }, { isActive: true })

  const walletOverlay = overlay?.type === 'wallet_browser'
    ? overlay.wallets.filter((wallet) => {
        const haystack = `${wallet.walletId} ${wallet.subjectId ?? ''} ${wallet.walletType ?? ''} ${wallet.state} ${wallet.trustStatus}`.toLowerCase()
        return haystack.includes(overlay.query.toLowerCase())
      })
    : []

  return (
    <Box flexDirection="column" gap={1} paddingY={1}>
      <Header sessionId={session.sessionId} persist={persist || !!solanaMeta} runsDir={runsDir} solanaMeta={solanaMeta} />

      {transcript.map((entry) => (
        <Panel key={entry.id} title={entry.title} lines={entry.lines} tone={entry.tone} />
      ))}

      {overlay?.type === 'wallet_browser' && (
        <WalletBrowser wallets={walletOverlay} query={overlay.query} selectedIndex={Math.min(overlay.selectedIndex, Math.max(walletOverlay.length - 1, 0))} />
      )}

      {overlay?.type === 'wallet_detail' && (
        <Panel title={overlay.title} lines={[...overlay.lines, 'Enter or Esc to return.']} tone="accent" />
      )}

      {overlay?.type === 'approval' && (
        <ApprovalReview runId={overlay.runId} summary={overlay.summary} selectedIndex={overlay.selectedIndex} />
      )}

      {overlay === null && commandSuggestions.length > 0 && (
        <SuggestionList specs={commandSuggestions} selectedIndex={Math.min(commandSelection, Math.max(commandSuggestions.length - 1, 0))} />
      )}

      <Box borderStyle="round" borderColor={busyLabel ? 'yellow' : 'cyan'} paddingX={1} paddingY={0} flexDirection="column">
        <PromptLine
          value={input}
          cursor={cursor}
          placeholder={overlay ? 'overlay active' : busyLabel ? 'working…' : 'Ask the runtime to do something'}
          busy={!!busyLabel}
        />
        <Text dimColor>
          {overlay?.type === 'wallet_browser'
            ? 'Wallet browser is active. Type to filter, Enter to inspect, Esc to cancel.'
            : overlay?.type === 'wallet_detail'
              ? 'Wallet detail is active. Enter or Esc returns to the prompt.'
              : overlay?.type === 'approval'
                ? 'Approval review is active. Choose approve or reject.'
                : 'Enter submits  Tab completes a slash command  Esc clears input  Ctrl+C exits'}
        </Text>
      </Box>

      <StatusBar sessionId={session.sessionId} lastRunId={lastRunId} busyLabel={busyLabel} overlay={overlay} />
    </Box>
  )
}
