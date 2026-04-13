import type { AssetTransferIntentPayload } from '../contracts/intent.js'
import { AIIntentParser } from './AIIntentParser.js'

export type ParseTransferRequestResult =
  | {
      ok: true
      payload: AssetTransferIntentPayload
    }
  | {
      ok: false
      error: string
    }

const TRANSFER_PATTERN =
  /\b(?:send|pay|transfer)\s+([0-9]+(?:\.[0-9]+)?)\s+([A-Za-z0-9._-]+)\s+to\s+(\S+?)(?:\s+(?:on|via)\s+([A-Za-z0-9._-]+))?(?:\s|$)/i

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isTransferPayload(
  value: Record<string, unknown>,
): value is AssetTransferIntentPayload {
  return (
    typeof value.destinationAddress === 'string' &&
    typeof value.chainId === 'string' &&
    typeof value.assetSymbol === 'string' &&
    typeof value.amount === 'string'
  )
}

export function parseTransferRequest(input: {
  text?: string
  payload?: Record<string, unknown>
}): ParseTransferRequestResult {
  if (input.payload && isTransferPayload(input.payload)) {
    return {
      ok: true,
      payload: {
        sourceWalletId: normalizeString(input.payload.sourceWalletId),
        destinationAddress: input.payload.destinationAddress,
        chainId: input.payload.chainId,
        assetSymbol: input.payload.assetSymbol,
        amount: input.payload.amount,
        counterpartyId: normalizeString(input.payload.counterpartyId),
        note: normalizeString(input.payload.note),
      },
    }
  }

  if (!input.text) {
    return {
      ok: false,
      error: 'Transfer request is missing both structured payload and text.',
    }
  }

  const match = input.text.match(TRANSFER_PATTERN)
  if (!match) {
    return {
      ok: false,
      error:
        'Could not parse transfer request text. Expected a pattern like "send 100 USDC to 0xabc on base".',
    }
  }

  const [, amount, assetSymbol, destinationAddress, chainId] = match
  if (!amount || !assetSymbol || !destinationAddress) {
    return {
      ok: false,
      error: 'Could not extract amount, asset, or destination from transfer request text.',
    }
  }
  return {
    ok: true,
    payload: {
      // Merge any partial fields from the payload (e.g. sourceWalletId injected by CLI)
      sourceWalletId: normalizeString(input.payload?.sourceWalletId),
      destinationAddress,
      chainId: chainId ?? 'unknown',
      assetSymbol: assetSymbol.toUpperCase(),
      amount,
    },
  }
}

/**
 * AI-powered parser: tries the fast regex first, falls back to GPT if it fails.
 * Accepts an optional `hints` object to inject context (e.g. sourceWalletId from CLI).
 */
export async function parseTransferRequestWithAI(input: {
  text?: string
  payload?: Record<string, unknown>
  hints?: Partial<AssetTransferIntentPayload>
}): Promise<ParseTransferRequestResult> {
  // 1. Structured payload takes precedence — no AI needed
  if (input.payload && isTransferPayload(input.payload)) {
    return {
      ok: true,
      payload: {
        sourceWalletId: normalizeString(input.payload.sourceWalletId),
        destinationAddress: input.payload.destinationAddress,
        chainId: input.payload.chainId,
        assetSymbol: input.payload.assetSymbol,
        amount: input.payload.amount,
        counterpartyId: normalizeString(input.payload.counterpartyId),
        note: normalizeString(input.payload.note),
      },
    }
  }

  if (!input.text) {
    return { ok: false, error: 'Transfer request is missing both structured payload and text.' }
  }

  // 2. Try regex (instant, no API call)
  const regexResult = parseTransferRequest({ text: input.text, payload: input.payload })
  if (regexResult.ok) return regexResult

  // 3. Regex failed — call AI
  const parser = new AIIntentParser()
  const hints: Partial<AssetTransferIntentPayload> = {
    sourceWalletId: normalizeString(input.payload?.sourceWalletId),
    ...input.hints,
  }
  return parser.parse(input.text, hints)
}
