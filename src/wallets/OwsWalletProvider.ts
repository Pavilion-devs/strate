import { getWallet } from '@open-wallet-standard/core'
import type {
  ResolvedTransferSourceWallet,
  WalletProvider,
  WalletProviderResolutionInput,
  WalletRecord,
} from '../contracts/wallet.js'
import { DeterministicWalletProvider } from './DeterministicWalletProvider.js'
import type { WalletRegistry } from './WalletRegistry.js'

type OwsWalletProviderDependencies = {
  registry: WalletRegistry
  vaultPath: string
  fallbackProvider?: WalletProvider
}

function isEvmRuntimeChain(chainId: string): boolean {
  return (
    chainId.startsWith('eip155:') ||
    chainId === 'base' ||
    chainId === 'base-sepolia' ||
    chainId === 'ethereum' ||
    chainId === 'arbitrum' ||
    chainId === 'polygon'
  )
}

function pickOwsAccount(wallet: ReturnType<typeof getWallet>, chainId: string) {
  if (isEvmRuntimeChain(chainId)) {
    return wallet.accounts.find((account) => account.chainId.startsWith('eip155:'))
  }

  if (chainId.includes('solana')) {
    return wallet.accounts.find((account) => account.chainId.startsWith('solana:'))
  }

  if (chainId.includes('cosmos')) {
    return wallet.accounts.find((account) => account.chainId.startsWith('cosmos:'))
  }

  return undefined
}

export class OwsWalletProvider implements WalletProvider {
  private readonly registry: WalletRegistry
  private readonly vaultPath: string
  private readonly fallbackProvider: WalletProvider

  constructor(input: OwsWalletProviderDependencies) {
    this.registry = input.registry
    this.vaultPath = input.vaultPath
    this.fallbackProvider =
      input.fallbackProvider ??
      new DeterministicWalletProvider({
        registry: this.registry,
      })
  }

  async resolveTransferSource(
    input: WalletProviderResolutionInput,
  ): Promise<ResolvedTransferSourceWallet> {
    const walletRecord = await this.registry.get(input.walletId)
    if (!walletRecord || walletRecord.providerId !== 'ows_wallet_provider') {
      return this.fallbackProvider.resolveTransferSource(input)
    }

    const providerWalletId =
      walletRecord.providerWalletId ?? walletRecord.providerWalletName
    if (!providerWalletId) {
      throw new Error(
        `OWS wallet ${walletRecord.walletId} is missing provider wallet metadata.`,
      )
    }

    const owsWallet = getWallet(
      providerWalletId,
      walletRecord.providerVaultPath ?? this.vaultPath,
    )
    const account = pickOwsAccount(owsWallet, input.chainId)
    if (!account) {
      throw new Error(
        `OWS wallet ${providerWalletId} has no account for runtime chain ${input.chainId}.`,
      )
    }

    const resolvedWallet: WalletRecord = {
      ...walletRecord,
      address: account.address,
      updatedAt: walletRecord.updatedAt,
    }

    return {
      providerId: 'ows_wallet_provider',
      wallet: resolvedWallet,
      address: account.address,
      signerProfileId:
        walletRecord.signerProfileId ??
        input.requiredSignerClass ??
        input.allowedSignerClasses?.[0] ??
        'mpc_default',
      signerClass:
        input.requiredSignerClass ??
        input.allowedSignerClasses?.[0] ??
        'mpc',
      supportedChains: walletRecord.supportedChains ?? [input.chainId],
    }
  }

  async provisionWallet(
    input: import('../contracts/wallet.js').WalletProvisionInput,
  ): Promise<import('../contracts/wallet.js').ProvisionedWallet> {
    // OWS manages user-controlled wallets — provisioning is not applicable.
    // Delegate to the fallback provider (DeterministicWalletProvider) for system wallets.
    return this.fallbackProvider.provisionWallet(input)
  }
}
