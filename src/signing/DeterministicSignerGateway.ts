import { createHash } from 'crypto'
import type {
  SignatureRequest,
  SignatureResult,
  SignatureResultStatus,
  SignerGateway,
} from '../contracts/signing.js'

type DeterministicSignerMode = 'pending' | 'signed' | 'sign_on_refresh'

export class DeterministicSignerGateway implements SignerGateway {
  private readonly mode: DeterministicSignerMode
  private readonly signerProfiles = new Map<string, string>()

  constructor(mode: DeterministicSignerMode = 'pending') {
    this.mode = mode
  }

  async requestSignature(input: SignatureRequest): Promise<SignatureResult> {
    this.signerProfiles.set(
      input.signatureRequestId,
      input.signer.signerProfileId,
    )

    if (this.mode === 'pending' || this.mode === 'sign_on_refresh') {
      return {
        status: 'pending',
        signatureRequestId: input.signatureRequestId,
        signerProfileId: input.signer.signerProfileId,
      }
    }

    const transactionHash = `0x${createHash('sha256')
      .update(input.signatureRequestId)
      .digest('hex')
      .slice(0, 64)}`

    return {
      status: 'signed',
      signatureRequestId: input.signatureRequestId,
      signerProfileId: input.signer.signerProfileId,
      transactionHash,
      signedPayloadRef: `signature:${input.signatureRequestId}:payload`,
      rawSignatureRef: `signature:${input.signatureRequestId}:raw`,
    }
  }

  async getSignatureStatus(
    _signatureRequestId: string,
  ): Promise<SignatureResultStatus> {
    return this.mode === 'sign_on_refresh' ? 'pending' : this.mode
  }

  async getSignatureResult(
    signatureRequestId: string,
  ): Promise<SignatureResult> {
    const signerProfileId =
      this.signerProfiles.get(signatureRequestId) ?? 'deterministic_signer'

    if (this.mode === 'pending') {
      return {
        status: 'pending',
        signatureRequestId,
        signerProfileId,
      }
    }

    const transactionHash = `0x${createHash('sha256')
      .update(signatureRequestId)
      .digest('hex')
      .slice(0, 64)}`

    return {
      status: 'signed',
      signatureRequestId,
      signerProfileId,
      transactionHash,
      signedPayloadRef: `signature:${signatureRequestId}:payload`,
      rawSignatureRef: `signature:${signatureRequestId}:raw`,
    }
  }

  async cancelSignatureRequest(_signatureRequestId: string): Promise<void> {
    return
  }
}
