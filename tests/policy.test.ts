import { describe, it, expect, beforeEach } from 'vitest'
import { RestrictivePolicyResolver } from '../src/policy/RestrictivePolicyResolver.js'
import type { PolicyProfile } from '../src/contracts/policy.js'
import type { PolicyResolutionInput } from '../src/contracts/policyResolution.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = '2026-04-13T10:00:00.000Z'
const now = () => NOW

function basePolicy(overrides: Partial<PolicyProfile> = {}): PolicyProfile {
  return {
    policyProfileId: 'policy_1',
    version: '1',
    createdAt: NOW,
    updatedAt: NOW,
    owner: { organizationId: 'org_1' },
    mode: 'copilot',
    scope: {
      environments: ['test'],
      allowedChains: [],
      deniedChains: [],
      allowedWalletIds: [],
      allowedTreasuryIds: [],
      allowedAssets: [],
      deniedAssets: [],
    },
    permissions: {
      actions: {
        'asset.transfer': { enabled: true },
      },
      counterparty: {},
      protocols: {},
      signer: { allowedSignerClasses: ['mpc'] },
      simulation: {},
    },
    approvals: {},
    identity: {},
    trust: {},
    emergency: { emergencyHaltEnabled: false },
    ...overrides,
  }
}

function baseInput(overrides: Partial<PolicyResolutionInput> = {}): PolicyResolutionInput {
  return {
    runId: 'run_1',
    sessionId: 'session_1',
    environment: 'test',
    actor: { actorId: 'actor_1', roleIds: ['operator'] },
    intentRef: {
      intentId: 'intent_1',
      version: '1',
      actionType: 'asset.transfer',
    },
    policyCandidates: [basePolicy()],
    ...overrides,
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('RestrictivePolicyResolver', () => {
  let resolver: RestrictivePolicyResolver

  beforeEach(() => {
    resolver = new RestrictivePolicyResolver({ now })
  })

  // ── basic allow / deny ────────────────────────────────────────────────────

  describe('basic allow/deny', () => {
    it('allows when action is enabled in a single matching policy', async () => {
      const result = await resolver.resolve(baseInput())
      expect(result.status).toBe('allowed')
    })

    it('denies when no policy candidates match the environment', async () => {
      const policy = basePolicy({
        scope: { environments: ['production'], allowedChains: [], deniedChains: [] },
      })
      const result = await resolver.resolve(
        baseInput({ environment: 'test', policyCandidates: [policy] }),
      )
      expect(result.status).toBe('denied')
      expect(result.reasonCodes).toContain('policy.no_applicable_profile')
    })

    it('denies when action is not enabled in applicable policies', async () => {
      const policy = basePolicy()
      policy.permissions.actions['asset.transfer'] = { enabled: false }

      const result = await resolver.resolve(baseInput({ policyCandidates: [policy] }))
      expect(result.status).toBe('denied')
      expect(result.reasonCodes).toContain('policy.action_not_enabled')
    })

    it('denies when action permission is missing from policy', async () => {
      const policy = basePolicy()
      policy.permissions.actions = {} // no asset.transfer entry

      const result = await resolver.resolve(baseInput({ policyCandidates: [policy] }))
      expect(result.status).toBe('denied')
      expect(result.reasonCodes).toContain('policy.action_not_enabled')
    })

    it('denies when emergency halt is active', async () => {
      const result = await resolver.resolve(
        baseInput({
          emergencyState: { haltActive: true },
        }),
      )
      expect(result.status).toBe('denied')
      expect(result.reasonCodes).toContain('policy.emergency_halt_active')
    })
  })

  // ── mode resolution ───────────────────────────────────────────────────────

  describe('mode resolution', () => {
    it('resolves to advisory when any candidate is advisory', async () => {
      const p1 = basePolicy({ mode: 'advisory' })
      const p2 = basePolicy({ policyProfileId: 'policy_2', mode: 'copilot' })

      // Both must cover the test environment
      const result = await resolver.resolve(baseInput({ policyCandidates: [p1, p2] }))

      expect(result.mode).toBe('advisory')
    })

    it('resolves to copilot when no advisory is present', async () => {
      const p1 = basePolicy({ mode: 'copilot' })
      const p2 = basePolicy({ policyProfileId: 'policy_2', mode: 'limited_autonomous' })

      const result = await resolver.resolve(baseInput({ policyCandidates: [p1, p2] }))

      expect(result.mode).toBe('copilot')
    })

    it('resolves to limited_autonomous when all candidates are limited_autonomous', async () => {
      const policy = basePolicy({ mode: 'limited_autonomous' })

      const result = await resolver.resolve(baseInput({ policyCandidates: [policy] }))

      expect(result.mode).toBe('limited_autonomous')
    })
  })

  // ── approval class ────────────────────────────────────────────────────────

  describe('approval class', () => {
    it('returns approvalClass none when no approval rule exists', async () => {
      const policy = basePolicy()
      policy.approvals = {} // no rule for asset.transfer

      const result = await resolver.resolve(baseInput({ policyCandidates: [policy] }))

      // In limited_autonomous mode with no review flags, approval class is none
      // But base policy is copilot, so additional controls are required → single_human via forceReview
      // Let's use limited_autonomous to get none
      const autonomousPolicy = basePolicy({ mode: 'limited_autonomous' })
      autonomousPolicy.approvals = {}

      const r2 = await resolver.resolve(baseInput({ policyCandidates: [autonomousPolicy] }))
      expect(r2.approvals.approvalClass).toBe('none')
    })

    it('returns approvalClass single_human when singleApprovalUnder is set', async () => {
      const policy = basePolicy({ mode: 'limited_autonomous' })
      policy.approvals = {
        'asset.transfer': { singleApprovalUnder: '100000' },
      }

      const result = await resolver.resolve(baseInput({ policyCandidates: [policy] }))

      expect(result.approvals.approvalClass).toBe('single_human')
      expect(result.approvals.requiredApprovals).toBe(1)
    })

    it('returns approvalClass dual_human when dualApprovalOver is set', async () => {
      const policy = basePolicy({ mode: 'limited_autonomous' })
      policy.approvals = {
        'asset.transfer': { dualApprovalOver: '100000' },
      }

      const result = await resolver.resolve(baseInput({ policyCandidates: [policy] }))

      expect(result.approvals.approvalClass).toBe('dual_human')
      expect(result.approvals.requiredApprovals).toBe(2)
    })

    it('prefers dual_human over single_human when both conditions set', async () => {
      const policy = basePolicy({ mode: 'limited_autonomous' })
      policy.approvals = {
        'asset.transfer': {
          singleApprovalUnder: '100000',
          dualApprovalOver: '100000',
        },
      }

      const result = await resolver.resolve(baseInput({ policyCandidates: [policy] }))

      expect(result.approvals.approvalClass).toBe('dual_human')
    })

    it('carries required roles from approval rule', async () => {
      const policy = basePolicy({ mode: 'limited_autonomous' })
      policy.approvals = {
        'asset.transfer': {
          singleApprovalUnder: '100000',
          requiredRoles: ['cfo', 'treasurer'],
        },
      }

      const result = await resolver.resolve(baseInput({ policyCandidates: [policy] }))

      expect(result.approvals.requiredRoles).toContain('cfo')
      expect(result.approvals.requiredRoles).toContain('treasurer')
    })

    it('sets roleSeparationRequired from approval rule', async () => {
      const policy = basePolicy({ mode: 'limited_autonomous' })
      policy.approvals = {
        'asset.transfer': {
          dualApprovalOver: '100000',
          roleSeparationRequired: true,
        },
      }

      const result = await resolver.resolve(baseInput({ policyCandidates: [policy] }))

      expect(result.approvals.roleSeparationRequired).toBe(true)
    })
  })

  // ── scope resolution ──────────────────────────────────────────────────────

  describe('scope resolution', () => {
    it('returns empty allowedChains when all policies have empty chains (allow all)', async () => {
      const result = await resolver.resolve(baseInput())
      expect(result.scope.allowedChains).toEqual([])
    })

    it('intersects allowedChains across multiple policies', async () => {
      const p1 = basePolicy({ scope: { environments: ['test'], allowedChains: ['solana-devnet', 'ethereum'], deniedChains: [] } })
      const p2 = basePolicy({ policyProfileId: 'p2', scope: { environments: ['test'], allowedChains: ['solana-devnet', 'base'], deniedChains: [] } })

      const result = await resolver.resolve(baseInput({ policyCandidates: [p1, p2] }))

      // Intersection: only solana-devnet is in both
      expect(result.scope.allowedChains).toContain('solana-devnet')
      expect(result.scope.allowedChains).not.toContain('ethereum')
      expect(result.scope.allowedChains).not.toContain('base')
    })
  })

  // ── wallet context checks ─────────────────────────────────────────────────

  describe('wallet context checks', () => {
    it('denies when wallet compliance is rejected', async () => {
      const result = await resolver.resolve(
        baseInput({
          walletContext: { complianceStatus: 'rejected' },
        }),
      )
      expect(result.status).toBe('denied')
      expect(result.reasonCodes).toContain('policy.wallet_compliance_blocked')
    })

    it('restricts when wallet compliance is pending', async () => {
      const result = await resolver.resolve(
        baseInput({
          walletContext: { complianceStatus: 'pending' },
        }),
      )
      expect(result.status).toBe('restricted')
      expect(result.reasonCodes).toContain('policy.wallet_compliance_incomplete')
    })

    it('denies when wallet state is not outbound-ready (e.g. draft)', async () => {
      const result = await resolver.resolve(
        baseInput({
          walletContext: { state: 'draft' },
        }),
      )
      expect(result.status).toBe('denied')
      expect(result.reasonCodes).toContain('policy.wallet_state_not_outbound_ready')
    })

    it('allows when wallet state is active_full', async () => {
      const policy = basePolicy({ mode: 'limited_autonomous' })
      const result = await resolver.resolve(
        baseInput({
          policyCandidates: [policy],
          walletContext: { state: 'active_full', complianceStatus: 'approved' },
        }),
      )
      expect(result.status).toBe('allowed')
    })

    it('denies when wallet trust status is blocked', async () => {
      const result = await resolver.resolve(
        baseInput({
          walletContext: { trustStatus: 'blocked' },
        }),
      )
      expect(result.status).toBe('denied')
      expect(result.reasonCodes).toContain('policy.wallet_trust_blocked')
    })
  })

  // ── output shape ──────────────────────────────────────────────────────────

  describe('output shape', () => {
    it('includes resolutionId tied to runId', async () => {
      const result = await resolver.resolve(baseInput({ runId: 'run_xyz' }))
      expect(result.resolutionId).toContain('run_xyz')
    })

    it('includes correct actionType in result', async () => {
      const result = await resolver.resolve(baseInput())
      expect(result.action.actionType).toBe('asset.transfer')
    })

    it('populates sourceProfiles from applicable candidates', async () => {
      const result = await resolver.resolve(baseInput())
      expect(result.sourceProfiles).toHaveLength(1)
      expect(result.sourceProfiles[0].policyProfileId).toBe('policy_1')
    })
  })
})
