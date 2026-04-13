import type { SessionState } from '../contracts/runtime.js'
import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import {
  getSessionDir,
  getSessionsDir,
  getSessionStatePath,
  resolveStorageBaseDir,
} from './fileLayout.js'

export interface SessionRegistry {
  get(sessionId: string): Promise<SessionState | undefined>
  put(session: SessionState): Promise<void>
  list(): Promise<SessionState[]>
  remove(sessionId: string): Promise<void>
}

export class InMemorySessionRegistry implements SessionRegistry {
  private readonly sessions = new Map<string, SessionState>()

  async get(sessionId: string): Promise<SessionState | undefined> {
    return this.sessions.get(sessionId)
  }

  async put(session: SessionState): Promise<void> {
    this.sessions.set(session.sessionId, session)
  }

  async list(): Promise<SessionState[]> {
    return [...this.sessions.values()]
  }

  async remove(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId)
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

export class FileSessionRegistry implements SessionRegistry {
  private readonly baseDir: string

  constructor(baseDir?: string) {
    this.baseDir = resolveStorageBaseDir(baseDir)
  }

  async get(sessionId: string): Promise<SessionState | undefined> {
    return readJsonFile<SessionState>(getSessionStatePath(sessionId, this.baseDir))
  }

  async put(session: SessionState): Promise<void> {
    const dir = getSessionDir(session.sessionId, this.baseDir)
    await mkdir(dir, { recursive: true })
    await writeFile(
      getSessionStatePath(session.sessionId, this.baseDir),
      JSON.stringify(session, null, 2),
      'utf8',
    )
  }

  async list(): Promise<SessionState[]> {
    try {
      const entries = await readdir(getSessionsDir(this.baseDir), {
        withFileTypes: true,
      })
      const sessions = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => this.get(entry.name)),
      )
      return sessions.filter((session): session is SessionState =>
        Boolean(session),
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

  async remove(sessionId: string): Promise<void> {
    await rm(getSessionDir(sessionId, this.baseDir), {
      recursive: true,
      force: true,
    })
  }
}
