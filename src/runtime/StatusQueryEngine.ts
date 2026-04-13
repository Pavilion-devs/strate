/**
 * StatusQueryEngine
 *
 * Handles natural language status queries using OpenAI function calling.
 * The model decides which tool(s) to call. We execute them against real
 * runtime registries and return structured results.
 *
 * No hardcoded query patterns. No prompt stuffing.
 * The model gets tool definitions — it figures out what the user wants.
 */

import OpenAI from 'openai'
import { Connection, PublicKey, LAMPORTS_PER_SOL, clusterApiUrl } from '@solana/web3.js'
import { readFile } from 'fs/promises'
import type { SessionState, RunState } from '../contracts/runtime.js'
import type { RunRegistry } from './runRegistry.js'
import type { WalletRegistry } from '../wallets/WalletRegistry.js'
import type { ExecutionLedger } from '../contracts/ledger.js'

export type StatusQueryResult = {
  output: string[]
  data: Record<string, unknown>
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_session',
      description: 'Get the current session state: active run, pending approvals, pending signatures, pending confirmations.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_runs',
      description: 'List all runs in the current session. Can filter by status.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['active', 'waiting_for_approval', 'waiting_for_signature', 'waiting_for_confirmation', 'completed', 'failed', 'halted'],
            description: 'Filter by run status. Omit to list all runs.',
          },
          limit: {
            type: 'number',
            description: 'Max number of runs to return. Default 10.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_run',
      description: 'Get details of a specific run by ID, or the most recent run if no ID is given.',
      parameters: {
        type: 'object',
        properties: {
          run_id: {
            type: 'string',
            description: 'Run ID. Omit to get the most recent run.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_approval_review_package',
      description: 'Get the canonical approval review package for a run (material view, policy refs, role requirements).',
      parameters: {
        type: 'object',
        properties: {
          run_id: {
            type: 'string',
            description: 'Run ID. Omit to use latest run waiting for approval or latest run.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_compliance_workflows',
      description: 'List wallet compliance workflows, optionally filtered by status or wallet type.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['not_started', 'pending', 'approved', 'rejected', 'restricted'],
            description: 'Filter by wallet compliance status.',
          },
          wallet_type: {
            type: 'string',
            enum: ['treasury', 'ops', 'user', 'vendor'],
            description: 'Filter by wallet type.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_compliance_workflow',
      description: 'Get the current compliance workflow details for a wallet by wallet ID or subject ID.',
      parameters: {
        type: 'object',
        properties: {
          wallet_id: { type: 'string', description: 'Wallet ID.' },
          subject_id: { type: 'string', description: 'Subject name or ID.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_wallets',
      description: 'List wallets registered in this organization. Can filter by type or state.',
      parameters: {
        type: 'object',
        properties: {
          wallet_type: {
            type: 'string',
            enum: ['treasury', 'ops', 'user', 'vendor'],
            description: 'Filter by wallet type.',
          },
          state: {
            type: 'string',
            description: 'Filter by wallet lifecycle state e.g. active_full, pending_compliance.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_wallet',
      description: 'Get details of a specific wallet by ID or subject name.',
      parameters: {
        type: 'object',
        properties: {
          wallet_id: { type: 'string', description: 'Wallet ID.' },
          subject_id: { type: 'string', description: 'Subject name or ID — finds the wallet linked to this subject.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_run_events',
      description: 'Get the ledger event history for a specific run. Shows all phases it went through.',
      parameters: {
        type: 'object',
        properties: {
          run_id: { type: 'string', description: 'Run ID to get events for.' },
        },
        required: ['run_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_wallet_balance',
      description: 'Get the on-chain SOL balance of a wallet address. Works for any Solana devnet or mainnet address.',
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'Base58 Solana wallet address.' },
          wallet_id: { type: 'string', description: 'Wallet ID — will look up the address from the registry.' },
          subject_id: { type: 'string', description: 'Subject name — will look up the wallet and its address.' },
          cluster: { type: 'string', description: 'Solana cluster: devnet (default), mainnet-beta, testnet.' },
        },
        required: [],
      },
    },
  },
]

// ── Tool executor ─────────────────────────────────────────────────────────────

type ToolDeps = {
  session: SessionState
  runs: RunRegistry
  wallets: WalletRegistry
  ledger: ExecutionLedger
  /** Optional — if provided, get_wallet_balance queries the real RPC */
  rpcUrl?: string
  cluster?: string
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  deps: ToolDeps,
): Promise<unknown> {
  switch (name) {
    case 'get_session': {
      const allRuns = await deps.runs.listBySession(deps.session.sessionId)
      return {
        sessionId: deps.session.sessionId,
        mode: deps.session.mode,
        environment: deps.session.environment,
        activeRunId: deps.session.activeRunId ?? null,
        totalRuns: allRuns.length,
        pendingApprovals: deps.session.pendingApprovalRunIds,
        pendingSignatures: deps.session.pendingSignatureRunIds,
        pendingConfirmations: deps.session.pendingConfirmationRunIds,
        halted: deps.session.halted,
      }
    }

    case 'list_runs': {
      const allRuns = await deps.runs.listBySession(deps.session.sessionId)
      const statusFilter = args['status'] as string | undefined
      const limit = (args['limit'] as number | undefined) ?? 10
      const filtered = statusFilter
        ? allRuns.filter((r) => r.status === statusFilter)
        : allRuns
      const sorted = filtered
        .sort((a, b) => b.lastUpdatedAt.localeCompare(a.lastUpdatedAt))
        .slice(0, limit)
      return sorted.map((r) => ({
        runId: r.runId,
        actionType: r.actionType,
        status: r.status,
        phase: r.currentPhase,
        lastUpdatedAt: r.lastUpdatedAt,
      }))
    }

    case 'get_run': {
      const runId = args['run_id'] as string | undefined
      if (runId) {
        const run = await deps.runs.get(runId)
        return run ?? { error: `Run ${runId} not found.` }
      }
      // Most recent run
      const allRuns = await deps.runs.listBySession(deps.session.sessionId)
      const latest = allRuns.sort((a, b) =>
        b.lastUpdatedAt.localeCompare(a.lastUpdatedAt),
      )[0]
      return latest ?? { error: 'No runs found in this session.' }
    }

    case 'get_approval_review_package': {
      const runId = args['run_id'] as string | undefined
      let run: RunState | undefined
      if (runId) {
        run = await deps.runs.get(runId)
      } else {
        const allRuns = await deps.runs.listBySession(deps.session.sessionId)
        const sortedRuns = allRuns.sort((a, b) =>
          b.lastUpdatedAt.localeCompare(a.lastUpdatedAt),
        )
        run =
          sortedRuns.find((candidate) => candidate.status === 'waiting_for_approval') ??
          sortedRuns[0]
      }

      if (!run) {
        return { error: 'No runs available for approval package lookup.' }
      }
      if (!run.approvalReviewArtifactPath) {
        return {
          error: `Run ${run.runId} does not have an approval review package artifact yet.`,
        }
      }

      try {
        const contents = await readFile(run.approvalReviewArtifactPath, 'utf8')
        return {
          runId: run.runId,
          approvalStateRef: run.approvalStateRef ?? null,
          path: run.approvalReviewArtifactPath,
          reviewPackage: JSON.parse(contents) as Record<string, unknown>,
        }
      } catch (error) {
        return {
          error: `Failed to read approval review package for run ${run.runId}: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }

    case 'list_compliance_workflows': {
      const orgId = deps.session.orgContext.organizationId ?? ''
      let wallets = orgId ? await deps.wallets.listByOrganization(orgId) : []
      if (wallets.length === 0) {
        wallets = await deps.wallets.list()
      }

      const statusFilter = args['status'] as string | undefined
      const typeFilter = args['wallet_type'] as string | undefined
      const filtered = wallets
        .filter((wallet) => wallet.complianceWorkflowId != null)
        .filter((wallet) =>
          statusFilter ? wallet.complianceStatus === statusFilter : true,
        )
        .filter((wallet) =>
          typeFilter ? wallet.walletType === typeFilter : true,
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

      return filtered.map((wallet) => ({
        walletId: wallet.walletId,
        subjectId: wallet.subjectId,
        walletType: wallet.walletType,
        state: wallet.state,
        complianceWorkflowId: wallet.complianceWorkflowId,
        complianceStatus: wallet.complianceStatus,
        complianceProviderId: wallet.complianceProviderId ?? null,
        complianceProviderCaseId: wallet.complianceProviderCaseId ?? null,
        updatedAt: wallet.updatedAt,
      }))
    }

    case 'get_compliance_workflow': {
      const walletId = args['wallet_id'] as string | undefined
      const subjectId = args['subject_id'] as string | undefined

      let wallet
      if (walletId) {
        wallet = await deps.wallets.get(walletId)
      } else if (subjectId) {
        const orgId = deps.session.orgContext.organizationId ?? ''
        let all = orgId ? await deps.wallets.listByOrganization(orgId) : []
        if (all.length === 0) all = await deps.wallets.list()
        wallet = all.find(
          (candidate) =>
            candidate.subjectId?.toLowerCase() === subjectId.toLowerCase(),
        )
      } else {
        return { error: 'Provide wallet_id or subject_id.' }
      }

      if (!wallet) {
        return { error: 'Compliance workflow not found.' }
      }

      return {
        walletId: wallet.walletId,
        subjectId: wallet.subjectId,
        walletType: wallet.walletType,
        state: wallet.state,
        complianceWorkflowId: wallet.complianceWorkflowId ?? null,
        complianceStatus: wallet.complianceStatus,
        complianceProviderId: wallet.complianceProviderId ?? null,
        complianceProviderCaseId: wallet.complianceProviderCaseId ?? null,
        policyAttachmentStatus: wallet.policyAttachmentStatus,
        trustStatus: wallet.trustStatus,
        updatedAt: wallet.updatedAt,
      }
    }

    case 'list_wallets': {
      const orgId = deps.session.orgContext.organizationId ?? ''
      let orgWallets = orgId ? await deps.wallets.listByOrganization(orgId) : []
      // If the org filter returns nothing, fall back to listing all wallets
      // (auto-provisioned wallets during transfers may lack an organizationId)
      if (orgWallets.length === 0) {
        orgWallets = await deps.wallets.list()
      }
      const typeFilter = args['wallet_type'] as string | undefined
      const stateFilter = args['state'] as string | undefined
      let filtered = orgWallets
      if (typeFilter) filtered = filtered.filter((w) => w.walletType === typeFilter)
      if (stateFilter) filtered = filtered.filter((w) => w.state === stateFilter)
      return filtered.map((w) => ({
        walletId: w.walletId,
        subjectId: w.subjectId,
        walletType: w.walletType,
        state: w.state,
        address: w.address,
        complianceStatus: w.complianceStatus,
        trustStatus: w.trustStatus,
      }))
    }

    case 'get_wallet': {
      const walletId = args['wallet_id'] as string | undefined
      const subjectId = args['subject_id'] as string | undefined
      if (walletId) {
        const wallet = await deps.wallets.get(walletId)
        return wallet ?? { error: `Wallet ${walletId} not found.` }
      }
      if (subjectId) {
        const orgId = deps.session.orgContext.organizationId ?? ''
        let all = orgId ? await deps.wallets.listByOrganization(orgId) : []
        if (all.length === 0) all = await deps.wallets.list()
        const match = all.find(
          (w) => w.subjectId?.toLowerCase() === subjectId.toLowerCase(),
        )
        return match ?? { error: `No wallet found for subject "${subjectId}".` }
      }
      return { error: 'Provide wallet_id or subject_id.' }
    }

    case 'get_run_events': {
      const runId = args['run_id'] as string
      const events = await deps.ledger.listForRun(runId)
      return events.map((e) => ({
        eventType: e.eventType,
        at: e.at,
        phase: e.phase,
        summary: e.summary,
      }))
    }

    case 'get_wallet_balance': {
      // Resolve address — from direct arg, wallet_id, or subject_id
      let address = args['address'] as string | undefined

      if (!address && args['wallet_id']) {
        const w = await deps.wallets.get(args['wallet_id'] as string)
        address = w?.address
        if (!address) return { error: `Wallet ${args['wallet_id']} has no address.` }
      }

      if (!address && args['subject_id']) {
        const all = await deps.wallets.list()
        const match = all.find((w) =>
          w.subjectId?.toLowerCase() === (args['subject_id'] as string).toLowerCase(),
        )
        address = match?.address
        if (!address) return { error: `No address found for subject "${args['subject_id']}".` }
      }

      if (!address) return { error: 'Provide address, wallet_id, or subject_id.' }

      // Query on-chain balance
      try {
        const cluster = (args['cluster'] as string | undefined) ?? deps.cluster ?? 'devnet'
        const rpcUrl = deps.rpcUrl ?? (
          cluster === 'localnet'
            ? 'http://127.0.0.1:8899'
            : clusterApiUrl(cluster as 'devnet' | 'mainnet-beta' | 'testnet')
        )
        const connection = new Connection(rpcUrl, 'confirmed')
        const pubkey = new PublicKey(address)
        const lamports = await connection.getBalance(pubkey)
        const sol = lamports / LAMPORTS_PER_SOL
        return {
          address,
          lamports,
          sol,
          cluster,
          display: `${sol} SOL`,
        }
      } catch (err) {
        return { error: `Balance check failed: ${err instanceof Error ? err.message : String(err)}` }
      }
    }

    default:
      return { error: `Unknown tool: ${name}` }
  }
}

// ── Engine ────────────────────────────────────────────────────────────────────

export class StatusQueryEngine {
  private readonly client: OpenAI
  private readonly model: string

  constructor(options: { apiKey?: string; model?: string } = {}) {
    this.client = new OpenAI({
      apiKey: options.apiKey ?? process.env['OPENAI_API_KEY'],
    })
    this.model = options.model ?? 'gpt-4o-mini'
  }

  async answer(
    query: string,
    deps: ToolDeps,
  ): Promise<StatusQueryResult> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: 'You are a status assistant for a crypto wallet agent runtime. Answer the user\'s query by calling the appropriate tool(s). Be concise and factual. Return only what was asked.',
      },
      { role: 'user', content: query },
    ]

    const allData: Record<string, unknown> = {}

    // Agentic loop — model may call multiple tools
    for (let step = 0; step < 5; step++) {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        tools: TOOLS,
        tool_choice: 'auto',
        messages,
      })

      const message = response.choices[0]?.message
      if (!message) break

      messages.push(message)

      // No tool calls — model has its answer
      if (!message.tool_calls || message.tool_calls.length === 0) {
        const text = message.content ?? 'No response.'
        return {
          output: text.split('\n').filter(Boolean),
          data: allData,
        }
      }

      // Execute all function tool calls in parallel (skip non-function tool types)
      const functionCalls = message.tool_calls.filter((tc) => tc.type === 'function')
      const toolResults = await Promise.all(
        functionCalls.map(async (tc) => {
          const fn = (tc as OpenAI.Chat.ChatCompletionMessageToolCall & { type: 'function' }).function
          const args = JSON.parse(fn.arguments || '{}') as Record<string, unknown>
          const result = await executeTool(fn.name, args, deps)
          allData[fn.name] = result
          return {
            role: 'tool' as const,
            tool_call_id: tc.id,
            content: JSON.stringify(result),
          }
        }),
      )

      messages.push(...toolResults)
    }

    return { output: ['Status query completed.'], data: allData }
  }
}
