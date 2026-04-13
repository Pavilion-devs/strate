/**
 * AIIntentParser
 *
 * Uses OpenAI to parse natural language transfer requests into structured
 * AssetTransferIntentPayload. Replaces the brittle regex parser for any
 * input that doesn't match the strict pattern.
 *
 * Falls back to the regex parser if OpenAI is unavailable.
 */

import OpenAI from 'openai'
import type { AssetTransferIntentPayload } from '../contracts/intent.js'

export type AIParseResult =
  | { ok: true; payload: AssetTransferIntentPayload }
  | { ok: false; error: string }

const SYSTEM_PROMPT = `You are an intent parser for a crypto wallet agent.
Extract transfer details from user messages and return ONLY valid JSON.

Return this exact shape:
{
  "destinationAddress": "<address or wallet identifier>",
  "chainId": "<chain — e.g. solana-devnet, solana, base, ethereum, unknown>",
  "assetSymbol": "<uppercase ticker — e.g. SOL, USDC, ETH>",
  "amount": "<numeric string — e.g. 1, 0.5, 100>",
  "sourceWalletId": "<source wallet if mentioned, else null>",
  "note": "<memo or note if mentioned, else null>"
}

Rules:
- chainId normalisation (IMPORTANT — be exact):
  * "devnet", "solana devnet", "solana-devnet" → "solana-devnet"
  * "mainnet", "solana mainnet", "solana-mainnet", "solana main" → "solana-mainnet"
  * "testnet", "solana testnet", "solana-testnet" → "solana-testnet"
  * "solana" alone with no qualifier → "solana-devnet" (default to devnet)
  * "base" → "base"
  * "ethereum", "eth", "mainnet" (EVM context) → "ethereum"
  * not mentioned at all → "unknown"
- assetSymbol: always uppercase. "sol" → "SOL", "usdc" → "USDC".
- amount: numeric string only, no currency symbols. "1sol" → amount "1" assetSymbol "SOL".
- If you cannot extract a required field (destinationAddress, amount, assetSymbol), return: {"error": "<reason>"}
- Do not include any text outside the JSON.`

export class AIIntentParser {
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
    hints: Partial<AssetTransferIntentPayload> = {},
  ): Promise<AIParseResult> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        max_tokens: 256,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
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

      const destination = parsed['destinationAddress']
      const amount = parsed['amount']
      const assetSymbol = parsed['assetSymbol']

      if (!destination || !amount || !assetSymbol) {
        return {
          ok: false,
          error: 'AI could not extract destination, amount, or asset from the request.',
        }
      }

      return {
        ok: true,
        payload: {
          destinationAddress: String(destination),
          chainId: String(parsed['chainId'] ?? hints.chainId ?? 'unknown'),
          assetSymbol: String(assetSymbol).toUpperCase(),
          amount: String(amount),
          sourceWalletId:
            (parsed['sourceWalletId'] as string | null) ?? hints.sourceWalletId,
          note: (parsed['note'] as string | null) ?? undefined,
        },
      }
    } catch (err) {
      return {
        ok: false,
        error: `AI parser failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }
}
