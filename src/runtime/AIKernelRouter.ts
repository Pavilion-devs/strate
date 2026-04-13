/**
 * AIKernelRouter
 *
 * Single AI call that classifies user input AND extracts structured payload.
 * This is the primary intent driver — replaces both the regex input classifier
 * and the regex transfer parser.
 *
 * One call answers:
 *   - What kind of input is this? (action_request, status_query, conversational, etc.)
 *   - What action does the user want? (asset.transfer, wallet.create, etc.)
 *   - What are the structured parameters?
 *
 * The kernel receives clean, typed data — no regex involved in the happy path.
 * Regex is kept only as a last-resort fallback at the kernel level.
 *
 * Provider chain:
 *   1. OpenAI (primary) — gpt-4o-mini
 *   2. Groq  (secondary) — falls back automatically if OpenAI fails
 *   3. conversational    — returned if both providers fail
 */

import OpenAI from 'openai'
import type { KernelInputKind } from '../contracts/runtime.js'
import type { IntentActionType, AssetTransferIntentPayload, WalletCreateIntentPayload } from '../contracts/intent.js'

export type RouterResult =
  | {
      kind: 'action_request'
      actionType: 'asset.transfer'
      payload: AssetTransferIntentPayload
      confidence: 'high' | 'medium' | 'low'
    }
  | {
      kind: 'action_request'
      actionType: 'wallet.create'
      payload: Partial<WalletCreateIntentPayload>
      confidence: 'high' | 'medium' | 'low'
    }
  | {
      kind: 'action_request'
      actionType: Exclude<IntentActionType, 'asset.transfer' | 'wallet.create'>
      payload: Record<string, unknown>
      confidence: 'high' | 'medium' | 'low'
    }
  | { kind: 'status_query'; query: string }
  | { kind: 'conversational'; text: string }
  | { kind: 'operator_command'; command: string }

const SYSTEM_PROMPT = {
  role: 'system' as const,
  content: JSON.stringify({
    task: 'Classify the user message and extract structured intent. Return ONLY valid JSON.',
    output_schema: {
      kind: { type: 'string', enum: ['action_request', 'status_query', 'operator_command', 'conversational'] },
      actionType: {
        type: ['string', 'null'],
        enum: ['asset.transfer', 'wallet.create', 'treasury.rebalance', 'treasury.payment_batch', 'identity.start_kyc', 'governance.vote', 'counterparty.whitelist', null],
        description: 'Required when kind is action_request, null otherwise.',
      },
      payload: { type: ['object', 'null'], description: 'Structured payload for the action. Null for non-action kinds.' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      query: { type: ['string', 'null'], description: 'Natural language query for status_query kind.' },
      command: { type: ['string', 'null'], description: 'Command string for operator_command kind.' },
    },
    kind_definitions: {
      action_request: 'User wants to perform an operation — send funds, create wallet, rebalance, etc.',
      status_query: 'User asks about current state, balance, history, pending items, wallet details.',
      operator_command: 'User approves, rejects, halts, resumes, or closes. Includes: "yes", "approve", "I approve", "looks good", "send it", "do it", "no", "cancel", "reject", "stop", "abort", "halt the run", "resume", "close session".',
      conversational: 'Anything else — greetings, clarifications, unclear input.',
    },
    operator_command_values: {
      approve: 'User approves — any of: yes, approve, I approve, confirmed, looks good, send it, go ahead, do it, ok, sure',
      reject: 'User rejects — any of: no, cancel, reject, deny, stop, abort, nope, decline',
      halt: 'User halts — "halt", "halt the run", "stop the run"',
      resume: 'User resumes — "resume", "resume the run", "continue"',
      approval_package: 'User requests approval review payload — "show approval package", "approval review package", "approval payload"',
      pending_compliance: 'User requests pending compliance work — "show pending compliance", "pending KYC", "list compliance workflows"',
      close_session: 'User closes — "close session", "exit", "quit"',
    },
    payload_schemas: {
      'treasury.rebalance': {
        treasuryId: 'Treasury identifier. Default "treasury_main" if not mentioned.',
        sourceWalletId: 'Source wallet ID if explicitly mentioned, else null.',
        destinationWalletId: 'Destination wallet ID if explicitly mentioned, else null.',
        chainId: 'Normalise same as asset.transfer. Default solana-devnet.',
        assetSymbol: 'UPPERCASE ticker. Required.',
        targetAmount: 'Numeric string. Required.',
        objective: 'buffer_restore | yield_exit | payment_readiness | manual_rebalance. Infer from context.',
      },
      'treasury.payment_batch': {
        treasuryId: 'Treasury identifier. Default "treasury_main" if not mentioned.',
        sourceWalletId: 'Source wallet ID if explicitly mentioned, else null.',
        chainId: 'Normalise same as asset.transfer. Default solana-devnet.',
        assetSymbol: 'UPPERCASE ticker. Required.',
        batchType: 'payroll | vendor | mixed. Infer from context.',
        payments: 'Array of objects: { destinationAddress, amount, counterpartyId?, note? }. Required with at least one payment.',
      },
      'asset.transfer': {
        destinationAddress: 'recipient address or identifier — required',
        chainId: 'chain id — normalise: devnet|solana devnet→solana-devnet, mainnet→solana-mainnet, testnet→solana-testnet, solana alone→solana-devnet, base→base, eth/ethereum→ethereum',
        assetSymbol: 'UPPERCASE ticker — SOL, USDC, ETH etc. "sol"→"SOL"',
        amount: 'numeric string only — "1sol"→"1", "$100"→"100"',
        sourceWalletId: 'source wallet if explicitly mentioned, else null',
        note: 'memo or note if mentioned, else null',
      },
      'wallet.create': {
        subjectType: 'individual | team | business — infer from context: contractor/person→individual, team/department→team, company/vendor/corp→business',
        subjectId: 'slugified name or identifier — "Acme Corp"→"acme_corp", "John"→"john". Required.',
        walletType: 'treasury | ops | user | vendor — infer: payout/contractor→vendor, treasury→treasury, ops/operational→ops, personal/user→user',
        environment: 'development | staging | production — default development',
        signerProfileId: 'explicit signer profile if mentioned, else null',
        initialPolicyProfileId: 'explicit policy profile if mentioned, else null',
      },
    },
    rules: [
      'Return ONLY valid JSON. No markdown, no explanation.',
      'For asset.transfer: destinationAddress, amount, assetSymbol are required. If missing return kind conversational.',
      'For wallet.create: subjectId and walletType are required. If missing return kind conversational.',
      'For treasury.payment_batch: payments (>=1), assetSymbol, and chainId are required. If missing return kind conversational.',
      'If intent is ambiguous, use kind conversational.',
    ],
    examples: [
      { input: 'send 1 SOL to 3iNbBd... on devnet', output: { kind: 'action_request', actionType: 'asset.transfer', payload: { destinationAddress: '3iNbBd...', chainId: 'solana-devnet', assetSymbol: 'SOL', amount: '1', sourceWalletId: null, note: null }, confidence: 'high', query: null, command: null } },
      { input: 'create a payout wallet for contractor Javier', output: { kind: 'action_request', actionType: 'wallet.create', payload: { subjectType: 'individual', subjectId: 'javier', walletType: 'vendor', environment: 'development', signerProfileId: null, initialPolicyProfileId: null }, confidence: 'high', query: null, command: null } },
      { input: 'what runs are pending?', output: { kind: 'status_query', actionType: null, payload: null, confidence: 'high', query: 'pending runs', command: null } },
      { input: 'halt the current run', output: { kind: 'operator_command', actionType: null, payload: null, confidence: 'high', query: null, command: 'halt' } },
      { input: 'yes', output: { kind: 'operator_command', actionType: null, payload: null, confidence: 'high', query: null, command: 'approve' } },
      { input: 'I approve', output: { kind: 'operator_command', actionType: null, payload: null, confidence: 'high', query: null, command: 'approve' } },
      { input: 'i approve.', output: { kind: 'operator_command', actionType: null, payload: null, confidence: 'high', query: null, command: 'approve' } },
      { input: 'approve the asset transfer', output: { kind: 'operator_command', actionType: null, payload: null, confidence: 'high', query: null, command: 'approve' } },
      { input: 'looks good, send it', output: { kind: 'operator_command', actionType: null, payload: null, confidence: 'high', query: null, command: 'approve' } },
      { input: 'no', output: { kind: 'operator_command', actionType: null, payload: null, confidence: 'high', query: null, command: 'reject' } },
      { input: 'cancel', output: { kind: 'operator_command', actionType: null, payload: null, confidence: 'high', query: null, command: 'reject' } },
      { input: 'reject the transfer', output: { kind: 'operator_command', actionType: null, payload: null, confidence: 'high', query: null, command: 'reject' } },
      { input: 'show approval package', output: { kind: 'operator_command', actionType: null, payload: null, confidence: 'high', query: null, command: 'approval_package' } },
      { input: 'show pending compliance', output: { kind: 'operator_command', actionType: null, payload: null, confidence: 'high', query: null, command: 'pending_compliance' } },
    ],
  }),
}

export class AIKernelRouter {
  private readonly primaryClient: OpenAI
  private readonly primaryModel: string
  private readonly groqClient: OpenAI | null
  private readonly groqModel: string

  constructor(options: { apiKey?: string; model?: string; groqApiKey?: string; groqModel?: string } = {}) {
    this.primaryClient = new OpenAI({
      apiKey: options.apiKey ?? process.env['OPENAI_API_KEY'],
    })
    this.primaryModel = options.model ?? 'gpt-4o-mini'

    const groqApiKey = options.groqApiKey ?? process.env['GROQ_API_KEY']
    this.groqModel = options.groqModel ?? process.env['GROQ_MODEL'] ?? 'openai/gpt-oss-20b'

    // Groq client is optional — only initialised when a key is available
    this.groqClient = groqApiKey
      ? new OpenAI({
          apiKey: groqApiKey,
          baseURL: 'https://api.groq.com/openai/v1',
        })
      : null
  }

  async route(
    text: string,
    hints: Record<string, unknown> = {},
  ): Promise<RouterResult> {
    const userMessage = Object.keys(hints).length > 0
      ? `${text}\n\n[Context: ${JSON.stringify(hints)}]`
      : text

    // Try primary (OpenAI), fall back to Groq, then return conversational.
    const result =
      (await this.callProvider(this.primaryClient, this.primaryModel, userMessage, text)) ??
      (this.groqClient
        ? await this.callProvider(this.groqClient, this.groqModel, userMessage, text)
        : null)

    return result ?? { kind: 'conversational', text }
  }

  /**
   * Calls a single provider with the classification prompt.
   * Returns a parsed RouterResult on success, null on any failure (network error,
   * invalid JSON, missing required fields). Null causes the caller to try the
   * next provider in the chain.
   */
  private async callProvider(
    client: OpenAI,
    model: string,
    userMessage: string,
    originalText: string,
  ): Promise<RouterResult | null> {
    try {
      const response = await client.chat.completions.create({
        model,
        temperature: 0,
        max_tokens: 400,
        messages: [
          SYSTEM_PROMPT,
          { role: 'user', content: userMessage },
        ],
      })

      const raw = response.choices[0]?.message?.content?.trim() ?? ''
      let parsed: Record<string, unknown>

      try {
        parsed = JSON.parse(raw)
      } catch {
        // Non-JSON response → signal failure so the next provider is tried
        return null
      }

      const kind = String(parsed['kind'] ?? 'conversational') as KernelInputKind

      if (kind === 'status_query') {
        return { kind: 'status_query', query: String(parsed['query'] ?? originalText) }
      }

      if (kind === 'operator_command') {
        return { kind: 'operator_command', command: String(parsed['command'] ?? originalText) }
      }

      if (kind === 'action_request') {
        const actionType = parsed['actionType'] as IntentActionType | null
        const payload = (parsed['payload'] ?? {}) as Record<string, unknown>
        const confidence = (parsed['confidence'] ?? 'medium') as 'high' | 'medium' | 'low'

        if (!actionType) {
          return { kind: 'conversational', text: originalText }
        }

        if (actionType === 'asset.transfer') {
          const dest = payload['destinationAddress']
          const amount = payload['amount']
          const asset = payload['assetSymbol']
          if (!dest || !amount || !asset) {
            return { kind: 'conversational', text: originalText }
          }
          return {
            kind: 'action_request',
            actionType: 'asset.transfer',
            payload: {
              destinationAddress: String(dest),
              chainId: String(payload['chainId'] ?? 'unknown'),
              assetSymbol: String(asset).toUpperCase(),
              amount: String(amount),
              sourceWalletId: (payload['sourceWalletId'] as string | null) ?? undefined,
              note: (payload['note'] as string | null) ?? undefined,
            },
            confidence,
          }
        }

        if (actionType === 'wallet.create') {
          return {
            kind: 'action_request',
            actionType: 'wallet.create',
            payload: payload as Partial<WalletCreateIntentPayload>,
            confidence,
          }
        }

        return {
          kind: 'action_request',
          actionType: actionType as Exclude<IntentActionType, 'asset.transfer' | 'wallet.create'>,
          payload,
          confidence,
        }
      }

      return { kind: 'conversational', text: originalText }
    } catch {
      // Network error, auth failure, rate limit, etc. → signal failure
      return null
    }
  }
}
