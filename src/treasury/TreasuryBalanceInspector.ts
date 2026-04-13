/**
 * TreasuryBalanceInspector
 *
 * Inspects wallet balances and computes rebalance planning decisions per
 * treasury-balance-policy.md:
 *   - spendable balance = raw balance − operating buffer − strategic reserve
 *   - destination readiness = current balance vs target
 *   - shortfall detection
 *   - post-execution floor check
 *
 * For Solana, queries the RPC directly.
 * For non-Solana or unknown chains, works with registry data only.
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL, clusterApiUrl } from '@solana/web3.js'
import type { WalletRecord } from '../contracts/wallet.js'
import type { TreasuryRebalanceIntentPayload } from '../contracts/intent.js'

export type WalletBalance = {
  walletId: string
  address: string
  chainId: string
  assetSymbol: string
  rawBalance: number
  /** Balance that can actually be moved (raw − buffer − reserve) */
  spendableBalance: number
  operatingBuffer: number
  strategicReserve: number
  status: 'healthy' | 'watch' | 'shortfall' | 'blocked'
  reasonCodes: string[]
}

export type RebalancePlan = {
  planId: string
  sourceWallet: WalletRecord
  destinationWallet: WalletRecord | null
  assetSymbol: string
  chainId: string
  requestedAmount: number
  feasibleAmount: number
  /** True if the source has enough spendable balance */
  canExecute: boolean
  /** Source post-execution balance (raw - feasible) */
  sourcePostBalance: number
  /** Whether post-execution source stays above its floor */
  sourceFloorSatisfied: boolean
  reasonCodes: string[]
  inspectedAt: string
}

type InspectorConfig = {
  /** Minimum SOL buffer to keep in any wallet (lamports as SOL fraction) */
  solOperatingBuffer: number
  /** Minimum USDC buffer */
  usdcOperatingBuffer: number
  /** Generic buffer for unknown assets */
  defaultOperatingBuffer: number
}

const DEFAULT_CONFIG: InspectorConfig = {
  solOperatingBuffer: 0.05,    // Keep 0.05 SOL for fees
  usdcOperatingBuffer: 10,     // Keep 10 USDC minimum
  defaultOperatingBuffer: 0,
}

export class TreasuryBalanceInspector {
  private readonly config: InspectorConfig
  private readonly rpcUrl: string | undefined

  constructor(options: {
    config?: Partial<InspectorConfig>
    rpcUrl?: string
    cluster?: string
  } = {}) {
    this.config = { ...DEFAULT_CONFIG, ...options.config }
    const cluster = options.cluster ?? 'devnet'
    this.rpcUrl = options.rpcUrl ?? (
      cluster === 'localnet'
        ? 'http://127.0.0.1:8899'
        : clusterApiUrl(cluster as 'devnet' | 'mainnet-beta' | 'testnet')
    )
  }

  /** Get on-chain SOL balance for an address */
  async getSolBalance(address: string): Promise<number> {
    try {
      const connection = new Connection(this.rpcUrl!, 'confirmed')
      const pubkey = new PublicKey(address)
      const lamports = await connection.getBalance(pubkey)
      return lamports / LAMPORTS_PER_SOL
    } catch {
      return 0
    }
  }

  /** Compute the operating buffer for a given asset */
  private bufferFor(assetSymbol: string): number {
    switch (assetSymbol.toUpperCase()) {
      case 'SOL': return this.config.solOperatingBuffer
      case 'USDC':
      case 'USDT': return this.config.usdcOperatingBuffer
      default: return this.config.defaultOperatingBuffer
    }
  }

  /** Inspect a single wallet's balance for a specific asset */
  async inspectWallet(
    wallet: WalletRecord,
    assetSymbol: string,
    chainId: string,
  ): Promise<WalletBalance> {
    let rawBalance = 0

    // For SOL on Solana chains, query the RPC
    if (
      assetSymbol.toUpperCase() === 'SOL' &&
      wallet.address &&
      (chainId.includes('solana') || chainId === 'devnet' || chainId === 'mainnet')
    ) {
      rawBalance = await this.getSolBalance(wallet.address)
    }
    // For other assets/chains, we'd query SPL balances or other providers.
    // For now we work with 0 — the simulation layer validates feasibility.

    const operatingBuffer = this.bufferFor(assetSymbol)
    const strategicReserve = 0  // No reserve rules in MVP
    const spendableBalance = Math.max(0, rawBalance - operatingBuffer - strategicReserve)

    const reasonCodes: string[] = []
    let status: WalletBalance['status'] = 'healthy'

    if (rawBalance <= 0) {
      status = 'shortfall'
      reasonCodes.push('balance.zero_or_unknown')
    } else if (rawBalance <= operatingBuffer) {
      status = 'watch'
      reasonCodes.push('balance.at_or_below_buffer')
    } else if (spendableBalance <= 0) {
      status = 'watch'
      reasonCodes.push('balance.no_spendable_after_buffer')
    }

    return {
      walletId: wallet.walletId,
      address: wallet.address ?? '',
      chainId,
      assetSymbol,
      rawBalance,
      spendableBalance,
      operatingBuffer,
      strategicReserve,
      status,
      reasonCodes,
    }
  }

  /** Plan a rebalance — checks feasibility and computes safe transfer amount */
  async planRebalance(
    payload: TreasuryRebalanceIntentPayload,
    sourceWallet: WalletRecord,
    destinationWallet: WalletRecord | null,
  ): Promise<RebalancePlan> {
    const planId = `plan_${Date.now().toString(36)}`
    const requestedAmount = parseFloat(payload.targetAmount)
    const reasonCodes: string[] = []

    const sourceBalance = await this.inspectWallet(
      sourceWallet,
      payload.assetSymbol,
      payload.chainId,
    )

    const feasibleAmount = Math.min(requestedAmount, sourceBalance.spendableBalance)
    const canExecute = feasibleAmount > 0 && feasibleAmount >= requestedAmount * 0.99 // 1% tolerance

    if (!canExecute) {
      if (sourceBalance.spendableBalance <= 0) {
        reasonCodes.push('source.no_spendable_balance')
      } else if (feasibleAmount < requestedAmount) {
        reasonCodes.push('source.insufficient_spendable_balance')
        reasonCodes.push(`source.available_${sourceBalance.spendableBalance.toFixed(6)}_${payload.assetSymbol}`)
      }
    }

    const sourcePostBalance = sourceBalance.rawBalance - feasibleAmount
    const sourceFloorSatisfied = sourcePostBalance >= sourceBalance.operatingBuffer

    if (!sourceFloorSatisfied) {
      reasonCodes.push('source.post_execution_below_floor')
    }

    return {
      planId,
      sourceWallet,
      destinationWallet,
      assetSymbol: payload.assetSymbol,
      chainId: payload.chainId,
      requestedAmount,
      feasibleAmount,
      canExecute,
      sourcePostBalance,
      sourceFloorSatisfied,
      reasonCodes,
      inspectedAt: new Date().toISOString(),
    }
  }
}
