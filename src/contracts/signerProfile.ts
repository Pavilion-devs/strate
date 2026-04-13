import type { SignerClass } from './common.js'

export type SignerCapabilities = {
  supportsAsyncStatus: boolean
  supportsCancellation: boolean
  supportsBatchSigning: boolean
  returnsRawSignature: boolean
  returnsSignedPayload: boolean
  maySubmitDirectly: boolean
  supportsPolicyMetadata: boolean
}

export type SignerProfile = {
  signerProfileId: string
  signerClass: SignerClass
  adapterId: string
  accountRefs: {
    walletId?: string
    vaultId?: string
    accountAddress?: string
    safeAddress?: string
  }
  supportedChains: string[]
  capabilities: SignerCapabilities
  authRef: string
  enabled: boolean
}
