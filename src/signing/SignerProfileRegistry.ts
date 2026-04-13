import type { SignerClass } from '../contracts/common.js'
import type { SignerProfile } from '../contracts/signerProfile.js'

export type ResolveSignerProfileInput = {
  signerProfileId?: string
  walletId?: string
  /** If undefined or empty string, chain check is skipped (policy allows all chains) */
  chainId?: string
  allowedSignerClasses: SignerClass[]
  requiredSignerClass?: SignerClass
}

function supportsChain(profile: SignerProfile, chainId: string | undefined): boolean {
  // No chainId → policy allows all chains, skip the check
  if (!chainId) return true
  // Empty supportedChains on profile → profile supports all chains
  return (
    profile.supportedChains.length === 0 ||
    profile.supportedChains.includes(chainId)
  )
}

function profileMatches(
  profile: SignerProfile,
  input: ResolveSignerProfileInput,
): boolean {
  if (!profile.enabled) {
    return false
  }

  if (!supportsChain(profile, input.chainId)) {
    return false
  }

  if (
    input.requiredSignerClass &&
    profile.signerClass !== input.requiredSignerClass
  ) {
    return false
  }

  return input.allowedSignerClasses.includes(profile.signerClass)
}

export function createDefaultSignerProfiles(): SignerProfile[] {
  return [
    {
      signerProfileId: 'mpc_default',
      signerClass: 'mpc',
      adapterId: 'deterministic_mpc',
      accountRefs: {},
      supportedChains: ['base', 'base-sepolia', 'ethereum', 'test'],
      capabilities: {
        supportsAsyncStatus: true,
        supportsCancellation: true,
        supportsBatchSigning: false,
        returnsRawSignature: true,
        returnsSignedPayload: true,
        maySubmitDirectly: false,
        supportsPolicyMetadata: true,
      },
      authRef: 'auth:mpc_default',
      enabled: true,
    },
    {
      signerProfileId: 'multisig_default',
      signerClass: 'multisig',
      adapterId: 'deterministic_multisig',
      accountRefs: {},
      supportedChains: ['base', 'base-sepolia', 'ethereum', 'test'],
      capabilities: {
        supportsAsyncStatus: true,
        supportsCancellation: false,
        supportsBatchSigning: true,
        returnsRawSignature: false,
        returnsSignedPayload: false,
        maySubmitDirectly: false,
        supportsPolicyMetadata: true,
      },
      authRef: 'auth:multisig_default',
      enabled: true,
    },
    {
      signerProfileId: 'smart_account_default',
      signerClass: 'smart_account',
      adapterId: 'deterministic_smart_account',
      accountRefs: {},
      supportedChains: ['base', 'base-sepolia', 'ethereum', 'test'],
      capabilities: {
        supportsAsyncStatus: true,
        supportsCancellation: false,
        supportsBatchSigning: true,
        returnsRawSignature: false,
        returnsSignedPayload: true,
        maySubmitDirectly: true,
        supportsPolicyMetadata: true,
      },
      authRef: 'auth:smart_account_default',
      enabled: true,
    },
  ]
}

export class SignerProfileRegistry {
  private readonly profiles = new Map<string, SignerProfile>()

  constructor(seedProfiles: SignerProfile[] = []) {
    for (const profile of seedProfiles) {
      this.register(profile)
    }
  }

  register(profile: SignerProfile): void {
    this.profiles.set(profile.signerProfileId, profile)
  }

  get(signerProfileId: string): SignerProfile | undefined {
    return this.profiles.get(signerProfileId)
  }

  list(): SignerProfile[] {
    return [...this.profiles.values()]
  }

  resolveCompatible(input: ResolveSignerProfileInput): SignerProfile {
    if (input.signerProfileId) {
      const exact = this.get(input.signerProfileId)
      if (!exact) {
        throw new Error(`Unknown signer profile: ${input.signerProfileId}`)
      }

      if (!profileMatches(exact, input)) {
        throw new Error(
          `Signer profile ${input.signerProfileId} is not compatible with chain or policy requirements.`,
        )
      }

      return exact
    }

    const compatibleProfiles = this.list().filter((profile) =>
      profileMatches(profile, input),
    )

    const walletScopedProfile = compatibleProfiles.find(
      (profile) =>
        input.walletId && profile.accountRefs.walletId === input.walletId,
    )
    if (walletScopedProfile) {
      return walletScopedProfile
    }

    const requiredClassProfile = compatibleProfiles.find(
      (profile) =>
        !input.requiredSignerClass ||
        profile.signerClass === input.requiredSignerClass,
    )
    if (requiredClassProfile) {
      return requiredClassProfile
    }

    throw new Error(
      `No compatible signer profile found for chain ${input.chainId}.`,
    )
  }
}
