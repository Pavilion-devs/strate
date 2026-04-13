/**
 * AITreasuryPaymentBatchParser
 *
 * AI-first parser for treasury payment batch requests.
 * Extracts a structured TreasuryPaymentBatchIntentPayload from natural language.
 */

import OpenAI from 'openai'
import type { TreasuryPaymentBatchIntentPayload } from '../contracts/intent.js'

export type ParseTreasuryPaymentBatchResult =
  | { ok: true; payload: TreasuryPaymentBatchIntentPayload }
  | { ok: false; error: string }

const SYSTEM_PROMPT = {
  role: 'system' as const,
  content: JSON.stringify({
    task: 'Parse a treasury payment batch request into structured JSON. Return ONLY valid JSON.',
    output_schema: {
      treasuryId: {
        type: 'string',
        description: 'Treasury identifier. Default "treasury_main".',
      },
      sourceWalletId: {
        type: ['string', 'null'],
        description: 'Source wallet ID if mentioned, otherwise null.',
      },
      chainId: {
        type: 'string',
        description:
          'Normalize chain: devnet -> solana-devnet, mainnet -> solana-mainnet, testnet -> solana-testnet, solana -> solana-devnet, base -> base, ethereum -> ethereum.',
      },
      assetSymbol: {
        type: 'string',
        description: 'UPPERCASE ticker (SOL, USDC, USDT, ETH).',
      },
      batchType: {
        type: ['string', 'null'],
        enum: ['payroll', 'vendor', 'mixed', null],
        description: 'Infer from context.',
      },
      payments: {
        type: 'array',
        description: 'List of payout legs in this batch.',
        items: {
          type: 'object',
          properties: {
            destinationAddress: { type: 'string' },
            amount: { type: 'string' },
            counterpartyId: { type: ['string', 'null'] },
            note: { type: ['string', 'null'] },
          },
          required: ['destinationAddress', 'amount'],
        },
      },
    },
    rules: [
      'payments is REQUIRED and must have at least one entry.',
      'assetSymbol is REQUIRED.',
      'chainId is REQUIRED (default to solana-devnet if omitted).',
      'Return {"missing":[...]} when required fields are missing.',
      'Return {"error":"not a payment batch request"} if unrelated.',
      'Return ONLY valid JSON and no extra text.',
    ],
    examples: [
      {
        input:
          'Run payroll batch: send 0.5 SOL to 9xabc..., 0.8 SOL to 7ydef... on devnet from wallet_payroll_main',
        output: {
          treasuryId: 'treasury_main',
          sourceWalletId: 'wallet_payroll_main',
          chainId: 'solana-devnet',
          assetSymbol: 'SOL',
          batchType: 'payroll',
          payments: [
            { destinationAddress: '9xabc...', amount: '0.5', counterpartyId: null, note: null },
            { destinationAddress: '7ydef...', amount: '0.8', counterpartyId: null, note: null },
          ],
        },
      },
      {
        input:
          'pay vendor batch 250 USDC to 0xaaa and 300 USDC to 0xbbb on base',
        output: {
          treasuryId: 'treasury_main',
          sourceWalletId: null,
          chainId: 'base',
          assetSymbol: 'USDC',
          batchType: 'vendor',
          payments: [
            { destinationAddress: '0xaaa', amount: '250', counterpartyId: null, note: null },
            { destinationAddress: '0xbbb', amount: '300', counterpartyId: null, note: null },
          ],
        },
      },
    ],
  }),
}

function isPayment(value: unknown): value is TreasuryPaymentBatchIntentPayload['payments'][number] {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    typeof item['destinationAddress'] === 'string' &&
    typeof item['amount'] === 'string'
  )
}

function isTreasuryPaymentBatchPayload(
  value: Record<string, unknown>,
): value is TreasuryPaymentBatchIntentPayload {
  return (
    typeof value['treasuryId'] === 'string' &&
    typeof value['chainId'] === 'string' &&
    typeof value['assetSymbol'] === 'string' &&
    Array.isArray(value['payments']) &&
    value['payments'].every(isPayment)
  )
}

export class AITreasuryPaymentBatchParser {
  private readonly client: OpenAI
  private readonly model: string

  constructor(options: { apiKey?: string; model?: string } = {}) {
    this.client = new OpenAI({
      apiKey: options.apiKey ?? process.env['OPENAI_API_KEY'],
    })
    this.model = options.model ?? 'gpt-4o-mini'
  }

  async parse(
    text: string,
    hints: Partial<TreasuryPaymentBatchIntentPayload> = {},
  ): Promise<ParseTreasuryPaymentBatchResult> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        max_tokens: 500,
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
        const missing = Array.isArray(parsed['missing'])
          ? parsed['missing'].map(String)
          : []
        return {
          ok: false,
          error: `To execute payment batch I need: ${missing.join(', ') || 'required fields'}.`,
        }
      }

      const payments = parsed['payments']
      if (!Array.isArray(payments) || payments.length === 0) {
        return {
          ok: false,
          error:
            'Could not extract batch payments. Provide at least one recipient and amount.',
        }
      }

      const normalizedPayments = payments
        .filter(isPayment)
        .map((payment) => ({
          destinationAddress: payment.destinationAddress,
          amount: payment.amount,
          counterpartyId: payment.counterpartyId,
          note: payment.note,
        }))

      if (normalizedPayments.length === 0) {
        return {
          ok: false,
          error: 'Could not extract valid payment entries from the batch request.',
        }
      }

      return {
        ok: true,
        payload: {
          treasuryId: String(parsed['treasuryId'] ?? hints.treasuryId ?? 'treasury_main'),
          sourceWalletId:
            (parsed['sourceWalletId'] as string | null | undefined) ??
            hints.sourceWalletId,
          chainId: String(parsed['chainId'] ?? hints.chainId ?? 'solana-devnet'),
          assetSymbol: String(parsed['assetSymbol'] ?? hints.assetSymbol ?? '').toUpperCase(),
          batchType:
            (parsed['batchType'] as TreasuryPaymentBatchIntentPayload['batchType'] | null) ??
            hints.batchType,
          payments: normalizedPayments,
        },
      }
    } catch (error) {
      return {
        ok: false,
        error: `AI payment batch parser failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }
    }
  }
}

export async function parseTreasuryPaymentBatchRequestWithAI(input: {
  text?: string
  payload?: Record<string, unknown>
  hints?: Partial<TreasuryPaymentBatchIntentPayload>
}): Promise<ParseTreasuryPaymentBatchResult> {
  if (input.payload && isTreasuryPaymentBatchPayload(input.payload)) {
    return {
      ok: true,
      payload: input.payload,
    }
  }

  if (!input.text) {
    return {
      ok: false,
      error: 'Payment batch request is missing both structured payload and text.',
    }
  }

  const parser = new AITreasuryPaymentBatchParser()
  return parser.parse(input.text, {
    sourceWalletId:
      (input.payload?.['sourceWalletId'] as string | undefined) ??
      input.hints?.sourceWalletId,
    treasuryId:
      (input.payload?.['treasuryId'] as string | undefined) ??
      input.hints?.treasuryId,
    chainId:
      (input.payload?.['chainId'] as string | undefined) ?? input.hints?.chainId,
    assetSymbol:
      (input.payload?.['assetSymbol'] as string | undefined) ??
      input.hints?.assetSymbol,
  })
}
