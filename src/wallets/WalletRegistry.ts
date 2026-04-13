import type { WalletRecord } from '../contracts/wallet.js'
import { mkdir, readFile, readdir, writeFile } from 'fs/promises'
import {
  getWalletDir,
  getWalletStatePath,
  getWalletsDir,
  resolveStorageBaseDir,
} from '../runtime/fileLayout.js'

export interface WalletRegistry {
  get(walletId: string): Promise<WalletRecord | undefined>
  put(wallet: WalletRecord): Promise<void>
  list(): Promise<WalletRecord[]>
  listByOrganization(organizationId: string): Promise<WalletRecord[]>
  listByTreasury(treasuryId: string): Promise<WalletRecord[]>
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    const contents = await readFile(filePath, 'utf8')
    return JSON.parse(contents) as T
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return undefined
    }

    throw error
  }
}

export class InMemoryWalletRegistry implements WalletRegistry {
  private readonly wallets = new Map<string, WalletRecord>()

  constructor(seedWallets: WalletRecord[] = []) {
    for (const wallet of seedWallets) {
      this.wallets.set(wallet.walletId, wallet)
    }
  }

  async get(walletId: string): Promise<WalletRecord | undefined> {
    return this.wallets.get(walletId)
  }

  async put(wallet: WalletRecord): Promise<void> {
    this.wallets.set(wallet.walletId, wallet)
  }

  async list(): Promise<WalletRecord[]> {
    return [...this.wallets.values()]
  }

  async listByOrganization(organizationId: string): Promise<WalletRecord[]> {
    return (await this.list()).filter(
      (wallet) => wallet.organizationId === organizationId,
    )
  }

  async listByTreasury(treasuryId: string): Promise<WalletRecord[]> {
    return (await this.list()).filter((wallet) => wallet.treasuryId === treasuryId)
  }
}

export class FileWalletRegistry implements WalletRegistry {
  private readonly baseDir: string

  constructor(baseDir?: string) {
    this.baseDir = resolveStorageBaseDir(baseDir)
  }

  async get(walletId: string): Promise<WalletRecord | undefined> {
    return readJsonFile<WalletRecord>(getWalletStatePath(walletId, this.baseDir))
  }

  async put(wallet: WalletRecord): Promise<void> {
    await mkdir(getWalletDir(wallet.walletId, this.baseDir), { recursive: true })
    await writeFile(
      getWalletStatePath(wallet.walletId, this.baseDir),
      JSON.stringify(wallet, null, 2),
      'utf8',
    )
  }

  async list(): Promise<WalletRecord[]> {
    try {
      const entries = await readdir(getWalletsDir(this.baseDir), {
        withFileTypes: true,
      })
      const wallets = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => this.get(entry.name)),
      )
      return wallets.filter((wallet): wallet is WalletRecord => Boolean(wallet))
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return []
      }

      throw error
    }
  }

  async listByOrganization(organizationId: string): Promise<WalletRecord[]> {
    return (await this.list()).filter(
      (wallet) => wallet.organizationId === organizationId,
    )
  }

  async listByTreasury(treasuryId: string): Promise<WalletRecord[]> {
    return (await this.list()).filter((wallet) => wallet.treasuryId === treasuryId)
  }
}
