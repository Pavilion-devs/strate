import { createHash } from 'crypto'
import type { IntentObject } from '../contracts/intent.js'

type TransferMaterialEnvelope = {
  intentId: string
  intentVersion: string
  actionType: string
  sourceWalletId?: string
  destinationAddress?: string
  chainId?: string
  assetSymbol?: string
  amount?: string
  counterpartyId?: string
  requiredSignerClass?: string
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    )
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`
  }

  return JSON.stringify(value)
}

export function buildTransferMaterialEnvelope(
  intent: IntentObject,
): TransferMaterialEnvelope {
  if (intent.action.type !== 'asset.transfer') {
    throw new Error(
      `Transfer material hash requires an asset.transfer intent, received ${intent.action.type}.`,
    )
  }

  return {
    intentId: intent.intentId,
    intentVersion: intent.version,
    actionType: intent.action.type,
    sourceWalletId: intent.action.payload.sourceWalletId,
    destinationAddress: intent.action.payload.destinationAddress,
    chainId: intent.action.payload.chainId,
    assetSymbol: intent.action.payload.assetSymbol,
    amount: intent.action.payload.amount,
    counterpartyId: intent.action.payload.counterpartyId,
    requiredSignerClass: intent.constraints.requiredSignerClass,
  }
}

export function createTransferMaterialHash(intent: IntentObject): string {
  const envelope = buildTransferMaterialEnvelope(intent)
  return createHash('sha256').update(stableStringify(envelope)).digest('hex')
}
