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
 *   Master Viewing Key (MVK)
 *   └── Mint Viewing Key (per token)
 *       └── Yearly Viewing Key
 *           └── Monthly Viewing Key
 *               └── Daily Viewing Key (most granular — grants view of one calendar day)
 *
 * Each level of the hierarchy grants view access to all transactions within its
 * time span for that mint. A Daily key lets an auditor see only that day's USDC
 * transfers — nothing else.
 *
 * ## Disclosure mechanism
 *
 * The `discloseTo()` method derives the appropriate viewing key for a given
 * reporting period and returns it as a base64-encoded string. The caller
 * (e.g., compliance officer UI) can then share this with an auditor, who
 * supplies it to the Umbra SDK's scanning functions to decrypt the relevant
 * ledger entries.
 *
 * ## Storage
 *
 * Viewing keys are sensitive — equivalent to read access for the disclosed period.
 * This extension stores key *references* (metadata + opaque encoded blob) but
 * does NOT persist the raw key material to disk. Callers are responsible for
 * passing disclosed keys through a secure channel (encrypted, access-controlled).
 */

import {
  getMasterViewingKeyDeriver,
  getMintViewingKeyDeriver,
  getYearlyViewingKeyDeriver,
  getMonthlyViewingKeyDeriver,
  getDailyViewingKeyDeriver,
} from '@umbra-privacy/sdk'
import type { IUmbraClient } from '@umbra-privacy/sdk'
import type { UmbraWalletProvider } from '../wallets/UmbraWalletProvider.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export type ViewingKeyScope = 'yearly' | 'monthly' | 'daily'

export type DisclosureParams = {
  /**
   * The Umbra wallet address that executed the transfer.
   * Used to scope the disclosure to a specific wallet's activity.
   */
  walletAddress: string
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
  /** Target scope — if narrower fields are provided, this is inferred; explicit override allowed */
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
  private readonly directClient: IUmbraClient | undefined

  constructor(deps: { walletProvider?: UmbraWalletProvider; client?: IUmbraClient }) {
    if (!deps.walletProvider && !deps.client) {
      throw new Error('ViewingKeyLedgerExtension: supply either walletProvider or client')
    }
    this.walletProvider = deps.walletProvider
    this.directClient = deps.client
  }

  /**
   * Derives an Umbra compliance viewing key for the given wallet + mint + period.
   *
   * The returned key can be handed to an auditor or compliance system. They use it
   * with the Umbra SDK's UTXO scanner to decrypt transaction records for the
   * specified mint and time window — without accessing any other transfers.
   *
   * @throws if the Umbra client is not initialized or the master seed is unavailable.
   */
  async discloseTo(params: DisclosureParams): Promise<ViewingKeyDisclosure> {
    const client = await this.resolveClient()

    const resolvedScope = resolveScope(params)
    const masterSeed = await client.masterSeed.getMasterSeed()

    // Derive master viewing key from seed
    const masterViewingKeyDeriver = getMasterViewingKeyDeriver(client)
    const mvk = await masterViewingKeyDeriver(masterSeed)

    // Derive mint-scoped viewing key
    const mintViewingKeyDeriver = getMintViewingKeyDeriver(client)
    const mintKey = await mintViewingKeyDeriver(mvk, params.mintAddress as Parameters<typeof mintViewingKeyDeriver>[1])

    let keyBytes: Uint8Array
    let period: { from: string; to: string }
    let description: string

    const { year, month = 1, day = 1 } = params

    if (resolvedScope === 'yearly') {
      const yearlyDeriver = getYearlyViewingKeyDeriver(client)
      const yearlyKey = await yearlyDeriver(mintKey, year as Parameters<typeof yearlyDeriver>[1])
      keyBytes = serializeViewingKey(yearlyKey)
      period = {
        from: `${year}-01-01`,
        to: `${year}-12-31`,
      }
      description = `Yearly viewing key for ${params.mintAddress} — ${year}`
    } else if (resolvedScope === 'monthly') {
      const yearlyDeriver = getYearlyViewingKeyDeriver(client)
      const yearlyKey = await yearlyDeriver(mintKey, year as Parameters<typeof yearlyDeriver>[1])
      const monthlyDeriver = getMonthlyViewingKeyDeriver(client)
      const monthlyKey = await monthlyDeriver(yearlyKey, month as Parameters<typeof monthlyDeriver>[1])
      keyBytes = serializeViewingKey(monthlyKey)
      const lastDay = new Date(year, month, 0).getDate()
      period = {
        from: `${year}-${String(month).padStart(2, '0')}-01`,
        to: `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
      }
      description = `Monthly viewing key for ${params.mintAddress} — ${year}/${String(month).padStart(2, '0')}`
    } else {
      // daily
      const yearlyDeriver = getYearlyViewingKeyDeriver(client)
      const yearlyKey = await yearlyDeriver(mintKey, year as Parameters<typeof yearlyDeriver>[1])
      const monthlyDeriver = getMonthlyViewingKeyDeriver(client)
      const monthlyKey = await monthlyDeriver(yearlyKey, month as Parameters<typeof monthlyDeriver>[1])
      const dailyDeriver = getDailyViewingKeyDeriver(client)
      const dailyKey = await dailyDeriver(monthlyKey, day as Parameters<typeof dailyDeriver>[1])
      keyBytes = serializeViewingKey(dailyKey)
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      period = { from: dateStr, to: dateStr }
      description = `Daily viewing key for ${params.mintAddress} — ${dateStr}`
    }

    return {
      keyBase64: Buffer.from(keyBytes).toString('base64'),
      scope: resolvedScope,
      mintAddress: params.mintAddress,
      period,
      description,
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async resolveClient(): Promise<IUmbraClient> {
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
 * Converts a viewing key object (opaque SDK type) into a Uint8Array for encoding.
 * Umbra viewing keys are Poseidon field elements — serialised as 32-byte little-endian.
 */
function serializeViewingKey(key: unknown): Uint8Array {
  // Umbra viewing keys are objects with a `value` field (bigint) or a raw Uint8Array.
  // Try each representation in order.
  if (key instanceof Uint8Array) return key

  if (typeof key === 'bigint') {
    const buf = new Uint8Array(32)
    let v = key
    for (let i = 0; i < 32; i++) {
      buf[i] = Number(v & 0xffn)
      v >>= 8n
    }
    return buf
  }

  if (key !== null && typeof key === 'object') {
    const obj = key as Record<string, unknown>
    if (obj['value'] instanceof Uint8Array) return obj['value'] as Uint8Array
    if (typeof obj['value'] === 'bigint') return serializeViewingKey(obj['value'])
    if (typeof obj['bytes'] !== 'undefined') return serializeViewingKey(obj['bytes'])
  }

  // Fallback: JSON-encode the key structure
  return new TextEncoder().encode(JSON.stringify(key))
}
