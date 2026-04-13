import { describe, it, expect, beforeEach } from 'vitest'
import { DeterministicApprovalEngine } from '../src/approval/DeterministicApprovalEngine.js'
import type { ResolvedPolicyProfile } from '../src/contracts/policyResolution.js'
import type { ApprovalRecord } from '../src/contracts/approval.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = '2026-04-13T10:00:00.000Z'
const FUTURE = '2026-04-13T11:00:00.000Z'
const PAST = '2026-04-13T09:00:00.000Z'

let counter = 0
const createId = (prefix: string) => `${prefix}_${++counter}`
const now = () => NOW

function makePolicy(overrides: Partial<ResolvedPolicyProfile['approvals']> = {}): ResolvedPolicyProfile {
  return {
    resolutionId: 'res_1',
    resolvedAt: NOW,
    mode: 'copilot',
    status: 'allowed',
    action: { actionType: 'asset.transfer', intentId: 'intent_1', intentVersion: '1' },
    scope: {
      environment: 'test',
      allowedChains: [],
      deniedChains: [],
      allowedWalletIds: [],
      allowedTreasuryIds: [],
      allowedAssets: [],
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
      reason: 'No approval required.',
      ...overrides,
    },
    signing: {
      allowedSignerClasses: [],
      requireSimulation: false,
      broadcastAllowed: true,
    },
    compliance: {
      kycRequired: false,
      kybRequired: false,
      sanctionsScreeningRequired: false,
      sourceOfFundsRequired: false,
      restrictedJurisdictions: [],
      status: 'satisfied',
    },
    trust: {
      manualReviewRequired: false,
    },
    emergency: {
      haltActive: false,
      pausedOutboundTransfers: false,
      pausedProductionSigning: false,
      breakGlassRoles: [],
    },
    derivedToolPolicy: {},
    sourceProfiles: [{ policyProfileId: 'policy_1', version: '1', precedence: 1, scopeType: 'organization' }],
    reasonCodes: [],
    explanation: '',
  }
}

function makeRecord(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    approvalRecordId: createId('record'),
    requirementId: 'req_placeholder', // overridden in each test
    approver: { actorId: 'actor_1', role: 'cfo' },
    decision: 'approved',
    decidedAt: NOW,
    intentRef: { intentId: 'intent_1', version: '1' },
    materialHash: 'hash_abc',
    ...overrides,
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('DeterministicApprovalEngine', () => {
  let engine: DeterministicApprovalEngine

  beforeEach(() => {
    counter = 0
    engine = new DeterministicApprovalEngine({ now, createId })
  })

  // ── evaluateRequirement ───────────────────────────────────────────────────

  describe('evaluateRequirement', () => {
    it('returns not_required when approvalClass is none', async () => {
      const policy = makePolicy({ approvalClass: 'none', requiredApprovals: 0 })
      const state = await engine.evaluateRequirement({
        intentRef: { intentId: 'intent_1', version: '1' },
        policy,
        materialHash: 'hash_abc',
        computedAt: NOW,
      })
      expect(state.status).toBe('not_required')
      expect(state.approvalClass).toBe('none')
    })

    it('returns pending when approvalClass is single_human', async () => {
      const policy = makePolicy({ approvalClass: 'single_human', requiredApprovals: 1 })
      const state = await engine.evaluateRequirement({
        intentRef: { intentId: 'intent_1', version: '1' },
        policy,
        materialHash: 'hash_abc',
        computedAt: NOW,
      })
      expect(state.status).toBe('pending')
      expect(state.approvalClass).toBe('single_human')
      expect(state.requirement.requiredApprovals).toBe(1)
    })

    it('returns pending when approvalClass is dual_human', async () => {
      const policy = makePolicy({ approvalClass: 'dual_human', requiredApprovals: 2 })
      const state = await engine.evaluateRequirement({
        intentRef: { intentId: 'intent_1', version: '1' },
        policy,
        materialHash: 'hash_abc',
        computedAt: NOW,
      })
      expect(state.status).toBe('pending')
      expect(state.requirement.requiredApprovals).toBe(2)
    })

    it('returns rejected when approvalClass is blocked', async () => {
      const policy = makePolicy({ approvalClass: 'blocked', requiredApprovals: 0 })
      const state = await engine.evaluateRequirement({
        intentRef: { intentId: 'intent_1', version: '1' },
        policy,
        materialHash: 'hash_abc',
        computedAt: NOW,
      })
      expect(state.status).toBe('rejected')
    })

    it('stores expiresAt from policy', async () => {
      const policy = makePolicy({
        approvalClass: 'single_human',
        requiredApprovals: 1,
        expiresAt: FUTURE,
      })
      const state = await engine.evaluateRequirement({
        intentRef: { intentId: 'intent_1', version: '1' },
        policy,
        materialHash: 'hash_abc',
        computedAt: NOW,
      })
      expect(state.expiresAt).toBe(FUTURE)
    })
  })

  // ── recordDecision ────────────────────────────────────────────────────────

  describe('recordDecision', () => {
    it('approves a single_human approval after one approval record', async () => {
      const policy = makePolicy({ approvalClass: 'single_human', requiredApprovals: 1 })
      const state = await engine.evaluateRequirement({
        intentRef: { intentId: 'intent_1', version: '1' },
        policy,
        materialHash: 'hash_abc',
        computedAt: NOW,
      })

      const updated = await engine.recordDecision({
        approvalStateId: state.approvalStateId,
        record: makeRecord({
          requirementId: state.requirement.requirementId,
          materialHash: state.requirement.materialHash,
        }),
      })

      expect(updated.status).toBe('approved')
      expect(updated.approvals).toHaveLength(1)
    })

    it('rejects when any approval record has decision rejected', async () => {
      const policy = makePolicy({ approvalClass: 'single_human', requiredApprovals: 1 })
      const state = await engine.evaluateRequirement({
        intentRef: { intentId: 'intent_1', version: '1' },
        policy,
        materialHash: 'hash_abc',
        computedAt: NOW,
      })

      const updated = await engine.recordDecision({
        approvalStateId: state.approvalStateId,
        record: makeRecord({
          requirementId: state.requirement.requirementId,
          materialHash: state.requirement.materialHash,
          decision: 'rejected',
        }),
      })

      expect(updated.status).toBe('rejected')
    })

    it('throws when material hash does not match', async () => {
      const policy = makePolicy({ approvalClass: 'single_human', requiredApprovals: 1 })
      const state = await engine.evaluateRequirement({
        intentRef: { intentId: 'intent_1', version: '1' },
        policy,
        materialHash: 'hash_abc',
        computedAt: NOW,
      })

      await expect(
        engine.recordDecision({
          approvalStateId: state.approvalStateId,
          record: makeRecord({
            requirementId: state.requirement.requirementId,
            materialHash: 'wrong_hash',
          }),
        }),
      ).rejects.toThrow('material hash mismatch')
    })

    it('throws when the same approver submits a second decision', async () => {
      const policy = makePolicy({ approvalClass: 'dual_human', requiredApprovals: 2 })
      const state = await engine.evaluateRequirement({
        intentRef: { intentId: 'intent_1', version: '1' },
        policy,
        materialHash: 'hash_abc',
        computedAt: NOW,
      })

      const firstRecord = makeRecord({
        requirementId: state.requirement.requirementId,
        materialHash: state.requirement.materialHash,
        approver: { actorId: 'actor_1', role: 'cfo' },
      })

      await engine.recordDecision({ approvalStateId: state.approvalStateId, record: firstRecord })

      await expect(
        engine.recordDecision({
          approvalStateId: state.approvalStateId,
          record: makeRecord({
            requirementId: state.requirement.requirementId,
            materialHash: state.requirement.materialHash,
            approver: { actorId: 'actor_1', role: 'cfo' }, // same actor
          }),
        }),
      ).rejects.toThrow('already submitted')
    })

    it('returns expired when decided after expiresAt', async () => {
      const policy = makePolicy({
        approvalClass: 'single_human',
        requiredApprovals: 1,
        expiresAt: PAST, // already expired
      })
      const state = await engine.evaluateRequirement({
        intentRef: { intentId: 'intent_1', version: '1' },
        policy,
        materialHash: 'hash_abc',
        computedAt: NOW,
      })

      const updated = await engine.recordDecision({
        approvalStateId: state.approvalStateId,
        record: makeRecord({
          requirementId: state.requirement.requirementId,
          materialHash: state.requirement.materialHash,
          decidedAt: NOW, // NOW > PAST so it's expired
        }),
      })

      expect(updated.status).toBe('expired')
    })

    it('stays pending when only one of two required approvals is received', async () => {
      const policy = makePolicy({ approvalClass: 'dual_human', requiredApprovals: 2 })
      const state = await engine.evaluateRequirement({
        intentRef: { intentId: 'intent_1', version: '1' },
        policy,
        materialHash: 'hash_abc',
        computedAt: NOW,
      })

      const updated = await engine.recordDecision({
        approvalStateId: state.approvalStateId,
        record: makeRecord({
          requirementId: state.requirement.requirementId,
          materialHash: state.requirement.materialHash,
          approver: { actorId: 'actor_1', role: 'cfo' },
        }),
      })

      expect(updated.status).toBe('pending')
    })

    it('approves dual_human after two distinct actors approve', async () => {
      const policy = makePolicy({ approvalClass: 'dual_human', requiredApprovals: 2 })
      const state = await engine.evaluateRequirement({
        intentRef: { intentId: 'intent_1', version: '1' },
        policy,
        materialHash: 'hash_abc',
        computedAt: NOW,
      })

      const afterFirst = await engine.recordDecision({
        approvalStateId: state.approvalStateId,
        record: makeRecord({
          requirementId: state.requirement.requirementId,
          materialHash: state.requirement.materialHash,
          approver: { actorId: 'actor_1', role: 'cfo' },
        }),
      })
      expect(afterFirst.status).toBe('pending')

      const afterSecond = await engine.recordDecision({
        approvalStateId: afterFirst.approvalStateId,
        record: makeRecord({
          requirementId: state.requirement.requirementId,
          materialHash: state.requirement.materialHash,
          approver: { actorId: 'actor_2', role: 'cto' },
        }),
      })
      expect(afterSecond.status).toBe('approved')
    })

    it('throws on unknown approvalStateId', async () => {
      await expect(
        engine.recordDecision({
          approvalStateId: 'nonexistent',
          record: makeRecord({ requirementId: 'r1', materialHash: 'h1' }),
        }),
      ).rejects.toThrow('Unknown approval state')
    })

    it('throws when recording on a terminal (approved) state', async () => {
      const policy = makePolicy({ approvalClass: 'single_human', requiredApprovals: 1 })
      const state = await engine.evaluateRequirement({
        intentRef: { intentId: 'intent_1', version: '1' },
        policy,
        materialHash: 'hash_abc',
        computedAt: NOW,
      })

      await engine.recordDecision({
        approvalStateId: state.approvalStateId,
        record: makeRecord({
          requirementId: state.requirement.requirementId,
          materialHash: state.requirement.materialHash,
        }),
      })

      await expect(
        engine.recordDecision({
          approvalStateId: state.approvalStateId,
          record: makeRecord({
            requirementId: state.requirement.requirementId,
            materialHash: state.requirement.materialHash,
            approver: { actorId: 'actor_2', role: 'cto' },
          }),
        }),
      ).rejects.toThrow('terminal')
    })
  })

  // ── invalidate ────────────────────────────────────────────────────────────

  describe('invalidate', () => {
    it('sets status to invalidated', async () => {
      const policy = makePolicy({ approvalClass: 'single_human', requiredApprovals: 1 })
      const state = await engine.evaluateRequirement({
        intentRef: { intentId: 'intent_1', version: '1' },
        policy,
        materialHash: 'hash_abc',
        computedAt: NOW,
      })

      const invalidated = await engine.invalidate(
        state.approvalStateId,
        'Intent payload changed.',
        NOW,
      )

      expect(invalidated.status).toBe('invalidated')
      expect(invalidated.invalidationReason).toContain('Intent payload changed.')
    })

    it('throws on unknown approvalStateId', async () => {
      await expect(
        engine.invalidate('nonexistent', 'reason', NOW),
      ).rejects.toThrow('Unknown approval state')
    })
  })

  // ── role separation ───────────────────────────────────────────────────────

  describe('role separation', () => {
    it('stays pending when dual_human with roleSeparationRequired gets same role twice', async () => {
      const policy = makePolicy({
        approvalClass: 'dual_human',
        requiredApprovals: 2,
        roleSeparationRequired: true,
      })
      const state = await engine.evaluateRequirement({
        intentRef: { intentId: 'intent_1', version: '1' },
        policy,
        materialHash: 'hash_abc',
        computedAt: NOW,
      })

      const afterFirst = await engine.recordDecision({
        approvalStateId: state.approvalStateId,
        record: makeRecord({
          requirementId: state.requirement.requirementId,
          materialHash: state.requirement.materialHash,
          approver: { actorId: 'actor_1', role: 'cfo' },
        }),
      })

      const afterSecond = await engine.recordDecision({
        approvalStateId: afterFirst.approvalStateId,
        record: makeRecord({
          requirementId: state.requirement.requirementId,
          materialHash: state.requirement.materialHash,
          approver: { actorId: 'actor_2', role: 'cfo' }, // same role, different actor
        }),
      })

      // Two approvals but same role — role separation not satisfied
      expect(afterSecond.status).toBe('pending')
    })

    it('approves when dual_human with roleSeparationRequired gets distinct roles', async () => {
      const policy = makePolicy({
        approvalClass: 'dual_human',
        requiredApprovals: 2,
        roleSeparationRequired: true,
      })
      const state = await engine.evaluateRequirement({
        intentRef: { intentId: 'intent_1', version: '1' },
        policy,
        materialHash: 'hash_abc',
        computedAt: NOW,
      })

      const afterFirst = await engine.recordDecision({
        approvalStateId: state.approvalStateId,
        record: makeRecord({
          requirementId: state.requirement.requirementId,
          materialHash: state.requirement.materialHash,
          approver: { actorId: 'actor_1', role: 'cfo' },
        }),
      })

      const afterSecond = await engine.recordDecision({
        approvalStateId: afterFirst.approvalStateId,
        record: makeRecord({
          requirementId: state.requirement.requirementId,
          materialHash: state.requirement.materialHash,
          approver: { actorId: 'actor_2', role: 'cto' }, // distinct role
        }),
      })

      expect(afterSecond.status).toBe('approved')
    })
  })
})
