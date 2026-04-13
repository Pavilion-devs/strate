import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import type { SignerProfile } from '../contracts/signerProfile.js'
import { SignerProfileRegistry } from './SignerProfileRegistry.js'
import {
  getSignerProfileDir,
  getSignerProfileStatePath,
  getSignerProfilesDir,
  resolveStorageBaseDir,
} from '../runtime/fileLayout.js'

function readJsonFile<T>(filePath: string): T | undefined {
  try {
    const contents = readFileSync(filePath, 'utf8')
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

export class PersistentSignerProfileRegistry extends SignerProfileRegistry {
  private readonly baseDir: string

  constructor(input: { baseDir?: string; seedProfiles?: SignerProfile[] } = {}) {
    super()
    this.baseDir = resolveStorageBaseDir(input.baseDir)

    const existingProfiles = this.readAll()
    if (existingProfiles.length > 0) {
      for (const profile of existingProfiles) {
        super.register(profile)
      }
      return
    }

    for (const profile of input.seedProfiles ?? []) {
      this.register(profile)
    }
  }

  override register(profile: SignerProfile): void {
    super.register(profile)
    mkdirSync(getSignerProfileDir(profile.signerProfileId, this.baseDir), {
      recursive: true,
    })
    writeFileSync(
      getSignerProfileStatePath(profile.signerProfileId, this.baseDir),
      JSON.stringify(profile, null, 2),
      'utf8',
    )
  }

  private readAll(): SignerProfile[] {
    try {
      const entries = readdirSync(getSignerProfilesDir(this.baseDir), {
        withFileTypes: true,
      })

      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) =>
          readJsonFile<SignerProfile>(
            getSignerProfileStatePath(entry.name, this.baseDir),
          ),
        )
        .filter((profile): profile is SignerProfile => Boolean(profile))
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
}
