/**
 * ViewingKeyLedgerExtension
 *
 * Attaches Umbra compliance viewing keys to execution ledger events, enabling
 * selective disclosure to auditors, regulators, or compliance systems without
 * revealing private transfer details to the public.
 *
 * ## How Umbra Viewing Keys Work
 *
 * The Umbra SDK derives a hierarchical set of viewing keys from the user's master seed:
 *
 *   Master Seed
 *   └── Master Viewing Key (MVK)
 *       └── Mint Viewing Key (per token)
 *           └── Yearly Viewing Key → Monthly → Daily
 *
 * Each level grants read access to all transactions within its time span for that mint.
 * A Daily key lets an auditor see only that day's USDC transfers — nothing else.
 *
 * ## Disclosure mechanism
 *
 * The `discloseTo()` method derives the appropriate viewing key for a given
 * reporting period and returns it as a base64-encoded string. The caller
 * (e.g., compliance officer UI) can share this with an auditor, who supplies it
 * to the Umbra SDK's scanning functions to decrypt the relevant ledger entries.
 *
 * ## Storage
 *
 * Viewing keys are sensitive — equivalent to read access for the disclosed period.
 * This extension returns key *disclosures* (metadata + encoded blob) but does NOT
 * persist raw key material to disk. Callers are responsible for routing disclosed
 * keys through a secure, encrypted channel.
 */

import {
  getYearlyViewingKeyDeriver,
  getMonthlyViewingKeyDeriver,
  getDailyViewingKeyDeriver,
  getUmbraClient,
} from '@umbra-privacy/sdk'
import type { UmbraWalletProvider, UmbraClient } from '../wallets/UmbraWalletProvider.js'

type UmbraNetwork = Parameters<typeof getUmbraClient>[0]['network']

// ─── Types ────────────────────────────────────────────────────────────────────

export type ViewingKeyScope = 'yearly' | 'monthly' | 'daily'

export type DisclosureParams = {
  /**
   * The SPL token mint address for which to generate a viewing key.
   * Example: USDC mint on devnet = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
   */
  mintAddress: string
  /**
   * The calendar period to disclose. Omitting narrower fields widens the scope:
   * - year only → yearly key (all transfers for that year)
   * - year + month → monthly key
   * - year + month + day → daily key (default and most granular)
   */
  year: number
  month?: number
  day?: number
  /** Explicit scope override — inferred from provided fields if omitted */
  scope?: ViewingKeyScope
}

export type ViewingKeyDisclosure = {
  /** Opaque base64-encoded viewing key blob for the requested period */
  keyBase64: string
  /** Resolved scope of this key */
  scope: ViewingKeyScope
  /** Mint the key grants read access for */
  mintAddress: string
  /** ISO date range the key covers */
  period: {
    from: string
    to: string
  }
  /** Human-readable description for audit trail */
  description: string
}

// ─── Extension ───────────────────────────────────────────────────────────────

export class ViewingKeyLedgerExtension {
  private readonly walletProvider: UmbraWalletProvider | undefined
  private readonly directClient: UmbraClient | undefined

  constructor(deps: { walletProvider?: UmbraWalletProvider; client?: UmbraClient }) {
    if (!deps.walletProvider && !deps.client) {
      throw new Error('ViewingKeyLedgerExtension: supply either walletProvider or client')
    }
    this.walletProvider = deps.walletProvider
    this.directClient = deps.client
  }

  /**
   * Derives an Umbra compliance viewing key for the given mint + reporting period.
   *
   * The returned key can be handed to an auditor or compliance system. They supply it
   * to the Umbra SDK's UTXO scanner to decrypt transaction records for the specified
   * mint and time window — without accessing any other transfers.
   *
   * @throws if the Umbra client is not initialised or the master seed is unavailable.
   */
  async discloseTo(params: DisclosureParams): Promise<ViewingKeyDisclosure> {
    const client = await this.resolveClient()
    const resolvedScope = resolveScope(params)

    const { mintAddress, year, month = 1, day = 1 } = params
    const mint = mintAddress as Parameters<ReturnType<typeof getYearlyViewingKeyDeriver>>[0]

    // Year / Month / Day must be bigint (Umbra uses branded bigint types internally)
    const yearN = BigInt(year) as unknown as Parameters<ReturnType<typeof getYearlyViewingKeyDeriver>>[1]
    const monthN = BigInt(month) as unknown as Parameters<ReturnType<typeof getMonthlyViewingKeyDeriver>>[2]
    const dayN = BigInt(day) as unknown as Parameters<ReturnType<typeof getDailyViewingKeyDeriver>>[3]

    let keyValue: unknown
    let period: { from: string; to: string }
    let description: string

    if (resolvedScope === 'yearly') {
      const deriver = getYearlyViewingKeyDeriver({ client })
      keyValue = await deriver(mint, yearN)
      period = {
        from: `${year}-01-01`,
        to: `${year}-12-31`,
      }
      description = `Yearly viewing key for ${mintAddress} — ${year}`
    } else if (resolvedScope === 'monthly') {
      const deriver = getMonthlyViewingKeyDeriver({ client })
      keyValue = await deriver(mint, yearN, monthN)
      const lastDay = new Date(year, month, 0).getDate()
      const mm = String(month).padStart(2, '0')
      period = {
        from: `${year}-${mm}-01`,
        to: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
      }
      description = `Monthly viewing key for ${mintAddress} — ${year}/${mm}`
    } else {
      const deriver = getDailyViewingKeyDeriver({ client })
      keyValue = await deriver(mint, yearN, monthN, dayN)
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      period = { from: dateStr, to: dateStr }
      description = `Daily viewing key for ${mintAddress} — ${dateStr}`
    }

    return {
      keyBase64: Buffer.from(serializeViewingKey(keyValue)).toString('base64'),
      scope: resolvedScope,
      mintAddress,
      period,
      description,
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async resolveClient(): Promise<UmbraClient> {
    if (this.directClient) return this.directClient
    if (this.walletProvider) return this.walletProvider.getClient()
    throw new Error('ViewingKeyLedgerExtension: no client available')
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveScope(params: DisclosureParams): ViewingKeyScope {
  if (params.scope) return params.scope
  if (params.day !== undefined) return 'daily'
  if (params.month !== undefined) return 'monthly'
  return 'yearly'
}

/**
 * Serialises an Umbra viewing key (opaque SDK type) into a Uint8Array.
 * Umbra viewing keys are BN254 field elements (≤252-bit bigint).
 * We encode them as 32-byte big-endian for portability.
 */
function serializeViewingKey(key: unknown): Uint8Array {
  if (key instanceof Uint8Array) return key

  if (typeof key === 'bigint') {
    const buf = new Uint8Array(32)
    let v = key
    for (let i = 31; i >= 0; i--) {
      buf[i] = Number(v & 0xffn)
      v >>= 8n
    }
    return buf
  }

  if (key !== null && typeof key === 'object') {
    const obj = key as Record<string, unknown>
    if (obj['value'] instanceof Uint8Array) return obj['value'] as Uint8Array
    if (typeof obj['value'] === 'bigint') return serializeViewingKey(obj['value'])
    if (obj['bytes'] instanceof Uint8Array) return obj['bytes'] as Uint8Array
  }

  // Fallback: JSON-encode the key structure
  return new TextEncoder().encode(JSON.stringify(key))
}
