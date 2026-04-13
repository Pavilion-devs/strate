import type { RunState } from '../contracts/runtime.js'
import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import {
  getRunDir,
  getRunManifestPath,
  getRunsDir,
  resolveStorageBaseDir,
} from './fileLayout.js'

export interface RunRegistry {
  get(runId: string): Promise<RunState | undefined>
  put(run: RunState): Promise<void>
  listBySession(sessionId: string): Promise<RunState[]>
  remove(runId: string): Promise<void>
}

export class InMemoryRunRegistry implements RunRegistry {
  private readonly runs = new Map<string, RunState>()

  async get(runId: string): Promise<RunState | undefined> {
    return this.runs.get(runId)
  }

  async put(run: RunState): Promise<void> {
    this.runs.set(run.runId, run)
  }

  async listBySession(sessionId: string): Promise<RunState[]> {
    return [...this.runs.values()].filter((run) => run.sessionId === sessionId)
  }

  async remove(runId: string): Promise<void> {
    this.runs.delete(runId)
  }
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

export class FileRunRegistry implements RunRegistry {
  private readonly baseDir: string

  constructor(baseDir?: string) {
    this.baseDir = resolveStorageBaseDir(baseDir)
  }

  async get(runId: string): Promise<RunState | undefined> {
    return readJsonFile<RunState>(getRunManifestPath(runId, this.baseDir))
  }

  async put(run: RunState): Promise<void> {
    const dir = getRunDir(run.runId, this.baseDir)
    await mkdir(dir, { recursive: true })
    await writeFile(
      getRunManifestPath(run.runId, this.baseDir),
      JSON.stringify(run, null, 2),
      'utf8',
    )
  }

  async listBySession(sessionId: string): Promise<RunState[]> {
    try {
      const entries = await readdir(getRunsDir(this.baseDir), {
        withFileTypes: true,
      })
      const runs = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => this.get(entry.name)),
      )
      return runs.filter(
        (run): run is RunState => run != null && run.sessionId === sessionId,
      )
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

  async remove(runId: string): Promise<void> {
    await rm(getRunDir(runId, this.baseDir), {
      recursive: true,
      force: true,
    })
  }
}
