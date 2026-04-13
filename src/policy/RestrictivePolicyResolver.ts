import type {
  PolicyResolver,
  PolicyResolutionInput,
  PolicySourceRef,
  ResolvedPolicyProfile,
} from '../contracts/policyResolution.js'
import type {
  ActionPermission,
  PolicyApprovalRule,
  PolicyProfile,
} from '../contracts/policy.js'
import type {
  PolicyExecutionMode,
  SignerClass,
  TrustAssessmentStatus,
} from '../contracts/common.js'
import { defaultNow } from '../runtime/types.js'

const MODE_ORDER: Record<PolicyExecutionMode, number> = {
  advisory: 0,
  copilot: 1,
  limited_autonomous: 2,
}

function mostRestrictiveMode(
  candidates: PolicyProfile[],
): PolicyExecutionMode {
  const modes = candidates.map((candidate) => candidate.mode)
  const sorted = [...modes].sort((left, right) => MODE_ORDER[left] - MODE_ORDER[right])
  return sorted[0] ?? 'advisory'
}

function intersectStringLists(lists: string[][]): string[] {
  if (lists.length === 0) {
    return []
  }

  return [...new Set(lists[0])].filter((value) =>
    lists.every((list) => list.includes(value)),
  )
}

function unionStringLists(lists: Array<string[] | undefined>): string[] {
  return [...new Set(lists.flatMap((list) => list ?? []))]
}

function buildSourceProfileRefs(
  candidates: PolicyProfile[],
): PolicySourceRef[] {
  return candidates.map((candidate, index) => ({
    policyProfileId: candidate.policyProfileId,
    version: candidate.version,
    precedence: index + 1,
    scopeType:
      candidate.owner.walletId
        ? 'wallet'
        : candidate.owner.treasuryId
          ? 'treasury'
          : candidate.owner.organizationId
            ? 'organization'
            : 'environment',
  }))
}

function resolveActionPermission(
  candidates: PolicyProfile[],
  actionType: PolicyResolutionInput['intentRef']['actionType'],
): ActionPermission | undefined {
  return candidates
    .map((candidate) => candidate.permissions.actions[actionType])
    .find((permission): permission is ActionPermission => Boolean(permission))
}

function resolveApprovalRule(
  candidates: PolicyProfile[],
  actionType: PolicyResolutionInput['intentRef']['actionType'],
): PolicyApprovalRule | undefined {
  return candidates
    .map((candidate) => candidate.approvals[actionType])
    .find((rule): rule is PolicyApprovalRule => Boolean(rule))
}

function unionSignerClasses(
  candidates: PolicyProfile[],
  actionPermission: ActionPermission | undefined,
): SignerClass[] {
  const signerClasses = new Set<SignerClass>()

  for (const signerClass of actionPermission?.allowedSignerClasses ?? []) {
    signerClasses.add(signerClass)
  }

  for (const candidate of candidates) {
    for (const signerClass of candidate.permissions.signer.allowedSignerClasses) {
      signerClasses.add(signerClass)
    }
  }

  return [...signerClasses]
}

function mapWalletTrustStatus(
  value: string | undefined,
): TrustAssessmentStatus | undefined {
  switch (value) {
    case 'sufficient':
      return 'sufficient'
    case 'limited':
      return 'limited'
    case 'manual_review':
      return 'manual_review'
    case 'blocked':
      return 'blocked'
    default:
      return undefined
  }
}

export class RestrictivePolicyResolver implements PolicyResolver {
  private readonly now: () => string

  constructor(dependencies: { now?: () => string } = {}) {
    this.now = dependencies.now ?? defaultNow
  }

  async resolve(input: PolicyResolutionInput): Promise<ResolvedPolicyProfile> {
    const applicable = input.policyCandidates.filter((candidate) =>
      candidate.scope.environments.includes(input.environment),
    )

    const resolvedAt = this.now()
    const mode = mostRestrictiveMode(applicable)
    const sourceProfiles = buildSourceProfileRefs(applicable)
    const actionPermission = resolveActionPermission(
      applicable,
      input.intentRef.actionType,
    )
    const approvalRule = resolveApprovalRule(applicable, input.intentRef.actionType)
    const emergencyHalt = input.emergencyState?.haltActive === true
    const allowedSignerClasses = unionSignerClasses(applicable, actionPermission)

    const allowedChains = intersectStringLists(
      applicable
        .map((candidate) => candidate.scope.allowedChains)
        .filter((chains) => chains.length > 0),
    )
    const allowedAssets = intersectStringLists(
      applicable
        .map((candidate) => candidate.scope.allowedAssets ?? [])
        .filter((assets) => assets.length > 0),
    )
    const deniedChains = unionStringLists(
      applicable.map((candidate) => candidate.scope.deniedChains),
    )
    const deniedAssets = unionStringLists(
      applicable.map((candidate) => candidate.scope.deniedAssets),
    )

    const reasonCodes: string[] = []
    let status: ResolvedPolicyProfile['status'] = 'allowed'
    let forceReview = false
    let complianceStatus: ResolvedPolicyProfile['compliance']['status'] = 'satisfied'

    if (applicable.length === 0) {
      status = 'denied'
      reasonCodes.push('policy.no_applicable_profile')
    }

    if (!actionPermission?.enabled) {
      status = 'denied'
      reasonCodes.push('policy.action_not_enabled')
    }

    if (emergencyHalt) {
      status = 'denied'
      reasonCodes.push('policy.emergency_halt_active')
    }

    if (
      input.walletContext?.walletId &&
      input.walletContext.walletId &&
      unionStringLists(
        applicable.map((candidate) => candidate.scope.allowedWalletIds),
      ).length > 0 &&
      !unionStringLists(
        applicable.map((candidate) => candidate.scope.allowedWalletIds),
      ).includes(input.walletContext.walletId)
    ) {
      status = 'denied'
      reasonCodes.push('policy.wallet_not_allowed')
    }

    if (
      input.walletContext?.signerClass &&
      allowedSignerClasses.length > 0 &&
      !allowedSignerClasses.includes(input.walletContext.signerClass)
    ) {
      status = 'denied'
      reasonCodes.push('policy.wallet_signer_class_not_allowed')
    }

    switch (input.walletContext?.state) {
      case 'active_limited':
        if (!actionPermission?.allowActiveLimitedAutoApproval) {
          if (status === 'allowed') {
            status = 'restricted'
          }
          forceReview = true
          reasonCodes.push('policy.wallet_state_limited_review_required')
        }
        break
      case 'active_full':
        break
      case 'draft':
      case 'provisioning':
      case 'created_unlinked':
      case 'linked_pending_policy':
      case 'pending_compliance':
      case 'active_receive_only':
      case 'restricted':
      case 'suspended':
      case 'rotating':
      case 'closed':
      case 'failed_incomplete':
        status = 'denied'
        reasonCodes.push('policy.wallet_state_not_outbound_ready')
        break
      default:
        break
    }

    switch (input.walletContext?.complianceStatus) {
      case 'restricted':
      case 'rejected':
        status = 'denied'
        complianceStatus = 'blocked'
        reasonCodes.push('policy.wallet_compliance_blocked')
        break
      case 'not_started':
      case 'pending':
        if (status === 'allowed') {
          status = 'restricted'
        }
        complianceStatus = 'missing'
        forceReview = true
        reasonCodes.push('policy.wallet_compliance_incomplete')
        break
      default:
        break
    }

    switch (input.walletContext?.signerHealthStatus) {
      case 'unavailable':
        status = 'denied'
        reasonCodes.push('policy.wallet_signer_unavailable')
        break
      case 'degraded':
        if (status === 'allowed') {
          status = 'restricted'
        }
        forceReview = true
        reasonCodes.push('policy.wallet_signer_degraded')
        break
      default:
        break
    }

    switch (input.walletContext?.trustStatus) {
      case 'blocked':
        status = 'denied'
        reasonCodes.push('policy.wallet_trust_blocked')
        break
      case 'limited':
      case 'manual_review':
      case 'unassessed':
        if (status === 'allowed') {
          status = 'restricted'
        }
        forceReview = true
        reasonCodes.push('policy.wallet_trust_review_required')
        break
      default:
        break
    }

    if (
      status === 'allowed' &&
      (mode === 'advisory' ||
        actionPermission?.approvalRequired ||
        actionPermission?.manualReviewOnly ||
        forceReview)
    ) {
      status = 'restricted'
      reasonCodes.push('policy.additional_controls_required')
    }

    const approvalClass = actionPermission?.manualReviewOnly
      ? 'manual_review_only'
      : approvalRule?.dualApprovalOver
        ? 'dual_human'
        : approvalRule?.singleApprovalUnder || actionPermission?.approvalRequired
          ? 'single_human'
          : forceReview
            ? 'manual_review_only'
            : 'none'

    return {
      resolutionId: `resolution_${input.runId}`,
      resolvedAt,
      mode,
      status,
      action: {
        actionType: input.intentRef.actionType,
        intentId: input.intentRef.intentId,
        intentVersion: input.intentRef.version,
      },
      scope: {
        environment: input.environment,
        allowedChains,
        deniedChains,
        allowedWalletIds: unionStringLists(
          applicable.map((candidate) => candidate.scope.allowedWalletIds),
        ),
        allowedTreasuryIds: unionStringLists(
          applicable.map((candidate) => candidate.scope.allowedTreasuryIds),
        ),
        allowedAssets,
        deniedAssets,
      },
      permissions: {
        actionType: input.intentRef.actionType,
        maxPerTransaction: actionPermission?.maxPerTransaction,
        allowedSignerClasses,
        simulationRequired:
          actionPermission?.simulationRequired ??
          applicable.some(
            (candidate) => candidate.permissions.simulation.requireTransferSimulation,
          ),
        manualReviewOnly: Boolean(actionPermission?.manualReviewOnly),
        allowlistedRecipientOnly: applicable.some(
          (candidate) => candidate.permissions.counterparty.allowlistedRecipientOnly,
        ),
        approvedCounterpartyIds: unionStringLists(
          applicable.map(
            (candidate) => candidate.permissions.counterparty.approvedCounterpartyIds,
          ),
        ),
        blockedCounterpartyIds: unionStringLists(
          applicable.map(
            (candidate) => candidate.permissions.counterparty.blockedCounterpartyIds,
          ),
        ),
        approvedBridgeIds: unionStringLists(
          applicable.map((candidate) => candidate.permissions.protocols.approvedBridgeIds),
        ),
        approvedRouterIds: unionStringLists(
          applicable.map((candidate) => candidate.permissions.protocols.approvedRouterIds),
        ),
        blockedProtocolIds: unionStringLists(
          applicable.map((candidate) => candidate.permissions.protocols.blockedProtocolIds),
        ),
      },
      approvals: {
        approvalClass,
        requiredApprovals:
          approvalClass === 'none'
            ? 0
            : approvalRule?.dualApprovalOver
              ? 2
              : 1,
        requiredRoles: approvalRule?.requiredRoles ?? [],
        roleSeparationRequired: Boolean(approvalRule?.roleSeparationRequired),
        reason:
          status === 'restricted'
            ? 'Policy requires additional approval controls.'
            : 'No additional approval controls required.',
        expiresAt: approvalRule?.approvalExpirySeconds
          ? new Date(
              Date.parse(resolvedAt) + approvalRule.approvalExpirySeconds * 1000,
            ).toISOString()
          : undefined,
      },
      signing: {
        allowedSignerClasses:
          actionPermission?.allowedSignerClasses ??
          applicable.flatMap((candidate) => candidate.permissions.signer.allowedSignerClasses),
        requiredSignerClass: actionPermission?.allowedSignerClasses?.[0],
        requireSimulation:
          actionPermission?.simulationRequired ??
          applicable.some(
            (candidate) => candidate.permissions.simulation.requireTransferSimulation,
          ),
        simulationFreshnessSeconds:
          applicable[0]?.permissions.simulation.simulationFreshnessSeconds,
        broadcastAllowed: status !== 'denied',
      },
      compliance: {
        kycRequired: applicable.some(
          (candidate) => candidate.identity.requireKycForWalletActivation,
        ),
        kybRequired: applicable.some(
          (candidate) => candidate.identity.requireKybForTreasuryActions,
        ),
        sanctionsScreeningRequired: applicable.some(
          (candidate) =>
            candidate.identity.requireSanctionsScreeningBeforeTransfer,
        ),
        sourceOfFundsRequired: applicable.some(
          (candidate) => Boolean(candidate.identity.sourceOfFundsRequiredOver),
        ),
        restrictedJurisdictions: unionStringLists(
          applicable.map((candidate) => candidate.identity.restrictedJurisdictions),
        ),
        status: complianceStatus,
      },
      trust: {
        minimumCounterpartyTrustTier: applicable[0]?.trust.minimumCounterpartyTrustTier,
        minimumWalletTrustTier: applicable[0]?.trust.minimumWalletTrustTier,
        counterpartyStatus: undefined,
        walletStatus: mapWalletTrustStatus(input.walletContext?.trustStatus),
        routeStatus: undefined,
        manualReviewRequired:
          Boolean(actionPermission?.manualReviewOnly) || forceReview,
      },
      emergency: {
        haltActive: emergencyHalt,
        pausedOutboundTransfers: applicable.some(
          (candidate) => candidate.emergency.pauseAllOutboundTransfers,
        ),
        pausedProductionSigning: applicable.some(
          (candidate) => candidate.emergency.pauseProductionSigning,
        ),
        breakGlassRoles: unionStringLists(
          applicable.map((candidate) => candidate.emergency.breakGlassRoles),
        ),
      },
      derivedToolPolicy: {
        'wallet.request_signature': {
          status:
            status === 'denied'
              ? 'denied'
              : status === 'restricted'
                ? 'approval_required'
                : 'allowed',
          reasonCodes,
        },
        'wallet.broadcast_transaction': {
          status: status === 'denied' ? 'denied' : 'approval_required',
          reasonCodes,
        },
      },
      sourceProfiles,
      reasonCodes,
      explanation:
        reasonCodes.length > 0
          ? reasonCodes.join(', ')
          : 'Policy resolved without additional restrictions.',
    }
  }
}
