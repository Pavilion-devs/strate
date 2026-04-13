import type { TrustAssessmentInput, TrustSignalResult } from '../contracts/trust.js'
import type { WalletRegistry } from '../wallets/WalletRegistry.js'

type CollectTrustSignalsDependencies = {
  wallets?: WalletRegistry
}

export async function collectTrustSignals(
  input: TrustAssessmentInput,
  dependencies: CollectTrustSignalsDependencies = {},
): Promise<TrustSignalResult[]> {
  if (input.objectType !== 'wallet') {
    return [
      {
        signalId: 'trust.scope.unsupported_object',
        family: 'org_context',
        status: 'missing',
        weight: 15,
        reasonCodes: ['trust.scope.unsupported_object'],
        evidenceRefs: [],
      },
    ]
  }

  const wallet = dependencies.wallets
    ? await dependencies.wallets.get(input.objectId)
    : undefined

  if (!wallet) {
    return [
      {
        signalId: 'trust.provenance.wallet_missing',
        family: 'provenance',
        status: 'missing',
        weight: 25,
        reasonCodes: ['trust.provenance.wallet_missing'],
        evidenceRefs: [],
      },
    ]
  }

  const evidenceBase = `wallet:${wallet.walletId}`
  const signals: TrustSignalResult[] = []

  if (wallet.complianceStatus === 'approved') {
    signals.push({
      signalId: 'trust.identity.verified',
      family: 'identity_compliance',
      status: 'positive',
      weight: 18,
      reasonCodes: ['trust.identity.verified'],
      evidenceRefs: [`${evidenceBase}#compliance:${wallet.complianceWorkflowId ?? 'approved'}`],
      observedAt: wallet.updatedAt,
    })
  } else if (
    wallet.complianceStatus === 'rejected' ||
    wallet.complianceStatus === 'restricted'
  ) {
    signals.push({
      signalId: 'trust.compliance.restricted',
      family: 'identity_compliance',
      status: 'hard_block',
      weight: 40,
      reasonCodes: ['trust.compliance.restricted'],
      evidenceRefs: [`${evidenceBase}#compliance:${wallet.complianceWorkflowId ?? 'restricted'}`],
      observedAt: wallet.updatedAt,
    })
  } else {
    signals.push({
      signalId: 'trust.identity.pending',
      family: 'identity_compliance',
      status: 'negative',
      weight: 20,
      reasonCodes: ['trust.identity.pending'],
      evidenceRefs: [`${evidenceBase}#compliance:${wallet.complianceWorkflowId ?? 'pending'}`],
      observedAt: wallet.updatedAt,
    })
  }

  if (wallet.providerId) {
    signals.push({
      signalId: 'trust.provenance.runtime_created',
      family: 'provenance',
      status: 'positive',
      weight: 12,
      reasonCodes: ['trust.provenance.runtime_created'],
      evidenceRefs: [`${evidenceBase}#provider:${wallet.providerId}`],
      observedAt: wallet.updatedAt,
    })
  } else {
    signals.push({
      signalId: 'trust.provenance.ownership_unverified',
      family: 'provenance',
      status: 'negative',
      weight: 12,
      reasonCodes: ['trust.provenance.ownership_unverified'],
      evidenceRefs: [evidenceBase],
      observedAt: wallet.updatedAt,
    })
  }

  if (wallet.policyAttachmentStatus === 'attached') {
    signals.push({
      signalId: 'trust.org.registry_linked',
      family: 'org_context',
      status: 'positive',
      weight: 8,
      reasonCodes: ['trust.org.registry_linked'],
      evidenceRefs: [`${evidenceBase}#policy:attached`],
      observedAt: wallet.updatedAt,
    })
  } else {
    signals.push({
      signalId: 'trust.provenance.ownership_unverified',
      family: 'org_context',
      status: 'missing',
      weight: 10,
      reasonCodes: ['trust.provenance.ownership_unverified'],
      evidenceRefs: [`${evidenceBase}#policy:${wallet.policyAttachmentStatus}`],
      observedAt: wallet.updatedAt,
    })
  }

  switch (wallet.signerHealthStatus) {
    case 'healthy':
      signals.push({
        signalId: 'trust.signer.healthy',
        family: 'signer_control',
        status: 'positive',
        weight: 8,
        reasonCodes: ['trust.signer.healthy'],
        evidenceRefs: [`${evidenceBase}#signer:${wallet.signerProfileId ?? 'unknown'}`],
        observedAt: wallet.updatedAt,
      })
      break
    case 'degraded':
      signals.push({
        signalId: 'trust.signer.rotating',
        family: 'signer_control',
        status: 'negative',
        weight: 12,
        reasonCodes: ['trust.signer.rotating'],
        evidenceRefs: [`${evidenceBase}#signer:${wallet.signerProfileId ?? 'unknown'}`],
        observedAt: wallet.updatedAt,
      })
      break
    case 'unavailable':
      signals.push({
        signalId: 'trust.signer.compromised',
        family: 'signer_control',
        status: 'hard_block',
        weight: 40,
        reasonCodes: ['trust.signer.compromised'],
        evidenceRefs: [`${evidenceBase}#signer:${wallet.signerProfileId ?? 'unknown'}`],
        observedAt: wallet.updatedAt,
      })
      break
    default:
      signals.push({
        signalId: 'trust.signer.rotating',
        family: 'signer_control',
        status: 'missing',
        weight: 10,
        reasonCodes: ['trust.signer.rotating'],
        evidenceRefs: [`${evidenceBase}#signer:${wallet.signerProfileId ?? 'unknown'}`],
        observedAt: wallet.updatedAt,
      })
      break
  }

  if (wallet.organizationId || wallet.subjectId) {
    signals.push({
      signalId: 'trust.org.registry_linked',
      family: 'org_context',
      status: 'positive',
      weight: 6,
      reasonCodes: ['trust.org.registry_linked'],
      evidenceRefs: [`${evidenceBase}#org:${wallet.organizationId ?? 'subject-linked'}`],
      observedAt: wallet.updatedAt,
    })
  } else {
    signals.push({
      signalId: 'trust.provenance.ownership_unverified',
      family: 'org_context',
      status: 'negative',
      weight: 14,
      reasonCodes: ['trust.provenance.ownership_unverified'],
      evidenceRefs: [evidenceBase],
      observedAt: wallet.updatedAt,
    })
  }

  return signals
}
