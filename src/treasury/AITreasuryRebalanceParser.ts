/**
 * AITreasuryRebalanceParser
 *
 * AI-first parser for treasury rebalance requests.
 * Extracts TreasuryRebalanceIntentPayload from natural language.
 * No regex. Structured JSON system prompt.
 */

import OpenAI from 'openai'
import type { TreasuryRebalanceIntentPayload } from '../contracts/intent.js'

export type ParseTreasuryRebalanceResult =
  | { ok: true; payload: TreasuryRebalanceIntentPayload }
  | { ok: false; error: string }

const SYSTEM_PROMPT = {
  role: 'system' as const,
  content: JSON.stringify({
    task: 'Parse a treasury rebalance request into structured JSON. Return ONLY valid JSON.',
    output_schema: {
      treasuryId: {
        type: 'string',
        description: 'Treasury identifier. Infer from context: "main treasury" → "treasury_main", "payroll treasury" → "treasury_payroll". Default to "treasury_main" if not mentioned.',
      },
      sourceWalletId: {
        type: ['string', 'null'],
        description: 'Source wallet to move funds FROM. Null if not mentioned.',
      },
      destinationWalletId: {
        type: ['string', 'null'],
        description: 'Destination wallet to move funds TO. Null if not mentioned.',
      },
      chainId: {
        type: 'string',
        description: 'Target chain. Normalise: devnet → solana-devnet, mainnet → solana-mainnet, base → base, ethereum → ethereum. Default "solana-devnet" if unclear.',
      },
      assetSymbol: {
        type: 'string',
        description: 'UPPERCASE token ticker. SOL, USDC, USDT, ETH. Required.',
      },
      targetAmount: {
        type: 'string',
        description: 'Numeric string — the amount to rebalance. Required.',
      },
      objective: {
        type: 'string',
        enum: ['buffer_restore', 'yield_exit', 'payment_readiness', 'manual_rebalance'],
        description: 'Rebalance objective. Infer: "restore buffer/reserve" → buffer_restore; "exit yield/unstake" → yield_exit; "ready for payroll/payments" → payment_readiness; anything else → manual_rebalance.',
      },
    },
    rules: [
      'assetSymbol is REQUIRED. Return {"missing": ["assetSymbol"]} if absent.',
      'targetAmount is REQUIRED. Return {"missing": ["targetAmount"]} if absent.',
      'Default treasuryId to "treasury_main" if not mentioned.',
      'Default objective to "manual_rebalance" if unclear.',
      'Return ONLY valid JSON. No markdown, no explanation.',
      'If unrelated to treasury/rebalance, return {"error": "not a rebalance request"}.',
    ],
    examples: [
      {
        input: 'Rebalance 500 USDC to Base for payroll',
        output: { treasuryId: 'treasury_main', sourceWalletId: null, destinationWalletId: null, chainId: 'base', assetSymbol: 'USDC', targetAmount: '500', objective: 'payment_readiness' },
      },
      {
        input: 'Move 1000 USDC from treasury_ops to treasury_payroll on solana devnet',
        output: { treasuryId: 'treasury_main', sourceWalletId: 'treasury_ops', destinationWalletId: 'treasury_payroll', chainId: 'solana-devnet', assetSymbol: 'USDC', targetAmount: '1000', objective: 'manual_rebalance' },
      },
      {
        input: 'Restore the SOL buffer — add 2 SOL to the reserve',
        output: { treasuryId: 'treasury_main', sourceWalletId: null, destinationWalletId: null, chainId: 'solana-devnet', assetSymbol: 'SOL', targetAmount: '2', objective: 'buffer_restore' },
      },
      {
        input: 'rebalance treasury, prepare 300 USDC for upcoming vendor payments',
        output: { treasuryId: 'treasury_main', sourceWalletId: null, destinationWalletId: null, chainId: 'solana-devnet', assetSymbol: 'USDC', targetAmount: '300', objective: 'payment_readiness' },
      },
    ],
  }),
}

export class AITreasuryRebalanceParser {
  private readonly client: OpenAI
  private readonly model: string

  constructor(options: { apiKey?: string; model?: string } = {}) {
    this.client = new OpenAI({
      apiKey: options.apiKey ?? process.env['OPENAI_API_KEY'],
    })
    this.model = options.model ?? 'gpt-4o-mini'
  }

  async parse(text: string): Promise<ParseTreasuryRebalanceResult> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        max_tokens: 300,
        messages: [
          SYSTEM_PROMPT,
          { role: 'user', content: text },
        ],
      })

      const raw = response.choices[0]?.message?.content?.trim() ?? ''

      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(raw)
      } catch {
        return { ok: false, error: `AI returned non-JSON: ${raw}` }
      }

      if (parsed['error']) {
        return { ok: false, error: String(parsed['error']) }
      }

      if (parsed['missing']) {
        const missing = parsed['missing'] as string[]
        const prompts: string[] = []
        if (missing.includes('assetSymbol')) prompts.push('which asset? (SOL, USDC, etc.)')
        if (missing.includes('targetAmount')) prompts.push('how much?')
        return {
          ok: false,
          error: `To plan the rebalance I need: ${prompts.join(' and ')}`,
        }
      }

      const assetSymbol = parsed['assetSymbol']
      const targetAmount = parsed['targetAmount']

      if (!assetSymbol || !targetAmount) {
        return {
          ok: false,
          error: 'Could not extract asset or amount. Try: "rebalance 500 USDC to Base for payroll".',
        }
      }

      return {
        ok: true,
        payload: {
          treasuryId: String(parsed['treasuryId'] ?? 'treasury_main'),
          sourceWalletId: (parsed['sourceWalletId'] as string | null) ?? undefined,
          destinationWalletId: (parsed['destinationWalletId'] as string | null) ?? undefined,
          chainId: String(parsed['chainId'] ?? 'solana-devnet'),
          assetSymbol: String(assetSymbol).toUpperCase(),
          targetAmount: String(targetAmount),
          objective: (parsed['objective'] as TreasuryRebalanceIntentPayload['objective']) ?? 'manual_rebalance',
        },
      }
    } catch (err) {
      return {
        ok: false,
        error: `AI rebalance parser failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }
}

/**
 * AI-first with structured payload short-circuit.
 */
export async function parseTreasuryRebalanceRequestWithAI(input: {
  text?: string
  payload?: Record<string, unknown>
}): Promise<ParseTreasuryRebalanceResult> {
  if (input.payload && isTreasuryRebalancePayload(input.payload)) {
    return {
      ok: true,
      payload: input.payload as TreasuryRebalanceIntentPayload,
    }
  }

  if (!input.text) {
    return { ok: false, error: 'Rebalance request is missing both structured payload and text.' }
  }

  const parser = new AITreasuryRebalanceParser()
  return parser.parse(input.text)
}

function isTreasuryRebalancePayload(
  value: Record<string, unknown>,
): value is TreasuryRebalanceIntentPayload {
  return (
    typeof value['assetSymbol'] === 'string' &&
    typeof value['targetAmount'] === 'string' &&
    typeof value['chainId'] === 'string'
  )
}
