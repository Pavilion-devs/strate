import type {
  SignatureRequest,
  SignatureResult,
  SignerGateway,
} from '../contracts/signing.js'

export class SignerGatewayRegistry {
  private readonly gateways = new Map<string, SignerGateway>()

  register(signerProfileId: string, gateway: SignerGateway): void {
    this.gateways.set(signerProfileId, gateway)
  }

  get(signerProfileId: string): SignerGateway | undefined {
    return this.gateways.get(signerProfileId)
  }

  async requestSignature(
    request: SignatureRequest,
  ): Promise<SignatureResult> {
    const gateway = this.get(request.signer.signerProfileId)
    if (!gateway) {
      return {
        status: 'failed',
        signatureRequestId: request.signatureRequestId,
        signerProfileId: request.signer.signerProfileId,
        errorMessage: `No signer gateway registered for ${request.signer.signerProfileId}.`,
      }
    }

    return gateway.requestSignature(request)
  }

  async getSignatureResult(
    signerProfileId: string,
    signatureRequestId: string,
  ): Promise<SignatureResult> {
    const gateway = this.get(signerProfileId)
    if (!gateway) {
      return {
        status: 'failed',
        signatureRequestId,
        signerProfileId,
        errorMessage: `No signer gateway registered for ${signerProfileId}.`,
      }
    }

    return gateway.getSignatureResult(signatureRequestId)
  }
}
