import { describe, it, expect, beforeEach } from 'vitest'
import { DeterministicSimulationEngine } from '../src/simulation/DeterministicSimulationEngine.js'
import type { IntentObject } from '../src/contracts/intent.js'
import type { ResolvedPolicyProfile } from '../src/contracts/policyResolution.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = '2026-04-13T10:00:00.000Z'

let counter = 0
const createId = (prefix: string) => `${prefix}_${++counter}`
const now = () => NOW

function makeTransferIntent(overrides: {
  amount?: string
  chainId?: string
  assetSymbol?: string
  destinationAddress?: string
  sourceWalletId?: string
} = {}): IntentObject {
  return {
    intentId: 'intent_1',
    version: '1',
    createdAt: NOW,
    createdBy: { actorType: 'human', actorId: 'actor_1' },
    status: 'draft',
    action: {
      type: 'asset.transfer',
      payload: {
        destinationAddress: overrides.destinationAddress ?? 'dest_addr_abc',
        chainId: overrides.chainId ?? 'solana-devnet',
        assetSymbol: overrides.assetSymbol ?? 'USDC',
        amount: overrides.amount ?? '100',
        sourceWalletId: overrides.sourceWalletId ?? 'wallet_src',
      },
    },
    scope: { environment: 'test', chainIds: ['solana-devnet'], assetSymbols: ['USDC'] },
    constraints: {},
    explanation: { normalizedSummary: 'send 100 USDC', effectStatement: 'Debit source, credit dest' },
    policyRefs: {},
    approvals: {},
    executionRefs: { simulationRefs: [], signatureRequestRefs: [], broadcastRefs: [] },
  }
}

function makePaymentBatchIntent(payments: Array<{ destinationAddress: string; amount: string }>): IntentObject {
  return {
    intentId: 'intent_batch_1',
    version: '1',
    createdAt: NOW,
    createdBy: { actorType: 'human', actorId: 'actor_1' },
    status: 'draft',
    action: {
      type: 'treasury.payment_batch',
      payload: {
        treasuryId: 'treasury_1',
        chainId: 'solana-devnet',
        assetSymbol: 'USDC',
        payments,
        batchType: 'payroll',
      },
    },
    scope: { environment: 'test', chainIds: ['solana-devnet'], assetSymbols: ['USDC'] },
    constraints: {},
    explanation: { normalizedSummary: 'payroll batch', effectStatement: 'Batch payments' },
    policyRefs: {},
    approvals: {},
    executionRefs: { simulationRefs: [], signatureRequestRefs: [], broadcastRefs: [] },
  }
}

function makePolicy(scopeOverrides: {
  allowedChains?: string[]
  allowedAssets?: string[]
} = {}): ResolvedPolicyProfile {
  return {
    resolutionId: 'res_1',
    resolvedAt: NOW,
    mode: 'copilot',
    status: 'allowed',
    action: { actionType: 'asset.transfer', intentId: 'intent_1', intentVersion: '1' },
    scope: {
      environment: 'test',
      allowedChains: scopeOverrides.allowedChains ?? [],
      deniedChains: [],
      allowedWalletIds: [],
      allowedTreasuryIds: [],
      allowedAssets: scopeOverrides.allowedAssets ?? [],
      deniedAssets: [],
    },
    permissions: {
      actionType: 'asset.transfer',
      allowedSignerClasses: [],
      simulationRequired: false,
      manualReviewOnly: false,
      allowlistedRecipientOnly: false,
      approvedCounterpartyIds: [],
      blockedCounterpartyIds: [],
      approvedBridgeIds: [],
      approvedRouterIds: [],
      blockedProtocolIds: [],
    },
    approvals: {
      approvalClass: 'none',
      requiredApprovals: 0,
      requiredRoles: [],
      roleSeparationRequired: false,
      reason: '',
    },
    signing: { allowedSignerClasses: [], requireSimulation: false, broadcastAllowed: true },
    compliance: {
      kycRequired: false,
      kybRequired: false,
      sanctionsScreeningRequired: false,
      sourceOfFundsRequired: false,
      restrictedJurisdictions: [],
      status: 'satisfied',
    },
    trust: { manualReviewRequired: false },
    emergency: {
      haltActive: false,
      pausedOutboundTransfers: false,
      pausedProductionSigning: false,
      breakGlassRoles: [],
    },
    derivedToolPolicy: {},
    sourceProfiles: [],
    reasonCodes: [],
    explanation: '',
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('DeterministicSimulationEngine', () => {
  let engine: DeterministicSimulationEngine

  beforeEach(() => {
    counter = 0
    engine = new DeterministicSimulationEngine({ now, createId })
  })

  // ── simulateTransfer ──────────────────────────────────────────────────────

  describe('simulateTransfer', () => {
    it('succeeds with valid transfer intent and open policy', async () => {
      const intent = makeTransferIntent()
      const policy = makePolicy()

      const result = await engine.simulateTransfer({
        runId: 'run_1',
        sessionId: 'session_1',
        intent,
        resolvedPolicy: policy,
        materialHash: 'hash_abc',
      })

      expect(result.status).toBe('succeeded')
      expect(result.invariants.every((inv) => inv.status === 'passed')).toBe(true)
    })

    it('throws when intent type is not asset.transfer', async () => {
      const walletIntent: IntentObject = {
        intentId: 'intent_w',
        version: '1',
        createdAt: NOW,
        createdBy: { actorType: 'human', actorId: 'actor_1' },
        status: 'draft',
        action: { type: 'wallet.create', payload: { subjectType: 'individual', subjectId: 'alice', walletType: 'vendor', environment: 'test' } },
        scope: { environment: 'test' },
        constraints: {},
        explanation: { normalizedSummary: '', effectStatement: '' },
        policyRefs: {},
        approvals: {},
        executionRefs: { simulationRefs: [], signatureRequestRefs: [], broadcastRefs: [] },
      }

      await expect(
        engine.simulateTransfer({
          runId: 'run_1',
          sessionId: 'session_1',
          intent: walletIntent,
          resolvedPolicy: makePolicy(),
          materialHash: 'hash_abc',
        }),
      ).rejects.toThrow('asset.transfer')
    })

    it('fails transfer.amount_positive invariant when amount is 0', async () => {
      const intent = makeTransferIntent({ amount: '0' })
      const policy = makePolicy()

      const result = await engine.simulateTransfer({
        runId: 'run_1',
        sessionId: 'session_1',
        intent,
        resolvedPolicy: policy,
        materialHash: 'hash_abc',
      })

      expect(result.status).toBe('failed')
      const inv = result.invariants.find((i) => i.invariantId === 'transfer.amount_positive')
      expect(inv?.status).toBe('failed')
    })

    it('fails policy.chain_allowed when chain is denied by policy', async () => {
      const intent = makeTransferIntent({ chainId: 'solana-devnet' })
      const policy = makePolicy({ allowedChains: ['ethereum'] }) // devnet not allowed

      const result = await engine.simulateTransfer({
        runId: 'run_1',
        sessionId: 'session_1',
        intent,
        resolvedPolicy: policy,
        materialHash: 'hash_abc',
      })

      expect(result.status).toBe('failed')
      const inv = result.invariants.find((i) => i.invariantId === 'policy.chain_allowed')
      expect(inv?.status).toBe('failed')
    })

    it('fails policy.asset_allowed when asset is denied by policy', async () => {
      const intent = makeTransferIntent({ assetSymbol: 'USDC' })
      const policy = makePolicy({ allowedAssets: ['SOL'] }) // only SOL allowed

      const result = await engine.simulateTransfer({
        runId: 'run_1',
        sessionId: 'session_1',
        intent,
        resolvedPolicy: policy,
        materialHash: 'hash_abc',
      })

      expect(result.status).toBe('failed')
      const inv = result.invariants.find((i) => i.invariantId === 'policy.asset_allowed')
      expect(inv?.status).toBe('failed')
    })

    it('produces correct asset deltas for a valid transfer', async () => {
      const intent = makeTransferIntent({
        amount: '250',
        assetSymbol: 'USDC',
        sourceWalletId: 'wallet_src',
        destinationAddress: 'wallet_dest',
      })
      const policy = makePolicy()

      const result = await engine.simulateTransfer({
        runId: 'run_1',
        sessionId: 'session_1',
        intent,
        resolvedPolicy: policy,
        materialHash: 'hash_abc',
      })

      expect(result.status).toBe('succeeded')
      const debit = result.expectedAssetDeltas.find((d) => d.direction === 'debit')
      const credit = result.expectedAssetDeltas.find((d) => d.direction === 'credit')
      expect(debit?.assetSymbol).toBe('USDC')
      expect(debit?.amount).toBe('250')
      expect(credit?.assetSymbol).toBe('USDC')
      expect(credit?.amount).toBe('250')
      expect(credit?.address).toBe('wallet_dest')
    })

    it('result hash is deterministic for identical inputs', async () => {
      const intent = makeTransferIntent()
      const policy = makePolicy()
      const input = { runId: 'run_1', sessionId: 'session_1', intent, resolvedPolicy: policy, materialHash: 'hash_abc' }

      const engine2 = new DeterministicSimulationEngine({ now, createId: () => 'fixed_id' })
      const engine3 = new DeterministicSimulationEngine({ now, createId: () => 'fixed_id' })

      const r1 = await engine2.simulateTransfer(input)
      const r2 = await engine3.simulateTransfer(input)

      expect(r1.resultHash).toBe(r2.resultHash)
    })

    it('passes all invariants when chains and assets are open (empty allowlists)', async () => {
      const intent = makeTransferIntent({ chainId: 'anything', assetSymbol: 'XYZ', amount: '1' })
      const policy = makePolicy({ allowedChains: [], allowedAssets: [] }) // empty = allow all

      const result = await engine.simulateTransfer({
        runId: 'run_1',
        sessionId: 'session_1',
        intent,
        resolvedPolicy: policy,
        materialHash: 'hash_abc',
      })

      expect(result.status).toBe('succeeded')
    })
  })

  // ── simulatePaymentBatch ──────────────────────────────────────────────────

  describe('simulatePaymentBatch', () => {
    it('succeeds with valid batch of 3 payments', async () => {
      const intent = makePaymentBatchIntent([
        { destinationAddress: 'addr_1', amount: '1000' },
        { destinationAddress: 'addr_2', amount: '2000' },
        { destinationAddress: 'addr_3', amount: '1500' },
      ])
      const policy = makePolicy()

      const result = await engine.simulatePaymentBatch({
        runId: 'run_1',
        sessionId: 'session_1',
        intent,
        resolvedPolicy: policy,
        materialHash: 'hash_batch',
      })

      expect(result.status).toBe('succeeded')
      // One debit + 3 credits
      const credits = result.expectedAssetDeltas.filter((d) => d.direction === 'credit')
      expect(credits).toHaveLength(3)
    })

    it('fails batch.has_payments invariant when payments array is empty', async () => {
      const intent = makePaymentBatchIntent([])
      const policy = makePolicy()

      const result = await engine.simulatePaymentBatch({
        runId: 'run_1',
        sessionId: 'session_1',
        intent,
        resolvedPolicy: policy,
        materialHash: 'hash_batch',
      })

      expect(result.status).toBe('failed')
      const inv = result.invariants.find((i) => i.invariantId === 'batch.has_payments')
      expect(inv?.status).toBe('failed')
    })

    it('fails batch.amounts_positive when any payment amount is 0', async () => {
      const intent = makePaymentBatchIntent([
        { destinationAddress: 'addr_1', amount: '1000' },
        { destinationAddress: 'addr_2', amount: '0' }, // invalid
      ])
      const policy = makePolicy()

      const result = await engine.simulatePaymentBatch({
        runId: 'run_1',
        sessionId: 'session_1',
        intent,
        resolvedPolicy: policy,
        materialHash: 'hash_batch',
      })

      expect(result.status).toBe('failed')
      const inv = result.invariants.find((i) => i.invariantId === 'batch.amounts_positive')
      expect(inv?.status).toBe('failed')
    })

    it('total amount in debit delta equals sum of all payment amounts', async () => {
      const intent = makePaymentBatchIntent([
        { destinationAddress: 'addr_1', amount: '500' },
        { destinationAddress: 'addr_2', amount: '300' },
        { destinationAddress: 'addr_3', amount: '200' },
      ])
      const policy = makePolicy()

      const result = await engine.simulatePaymentBatch({
        runId: 'run_1',
        sessionId: 'session_1',
        intent,
        resolvedPolicy: policy,
        materialHash: 'hash_batch',
      })

      expect(result.status).toBe('succeeded')
      const debit = result.expectedAssetDeltas.find((d) => d.direction === 'debit')
      expect(Number(debit?.amount)).toBe(1000) // 500 + 300 + 200
    })
  })
})
