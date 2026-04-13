import type {
  ArtifactRef,
  ExecutionLedger,
  LedgerEvent,
} from '../contracts/ledger.js'
import type { TranscriptEntry } from '../contracts/runtime.js'
import { createHash } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'
import {
  getArtifactAbsolutePath,
  getRunArtifactsDir,
  getRunCloseoutDir,
  getRunIndexesDir,
  getRunLedgerDir,
  getRunLedgerEventsPath,
  getRunTranscriptPath,
  getSessionTranscriptPath,
  resolveStorageBaseDir,
} from './fileLayout.js'

export interface TranscriptStore {
  append(entry: TranscriptEntry): Promise<void>
  list(sessionId: string): Promise<TranscriptEntry[]>
}

export interface ArtifactStore {
  write(
    artifact: Omit<ArtifactRef, 'artifactId'> & { artifactId?: string },
    data?: unknown,
  ): Promise<ArtifactRef>
}

export interface KernelPersistence {
  transcript: TranscriptStore
  ledger: ExecutionLedger
  artifacts: ArtifactStore
  flushCritical(sessionId: string, runId?: string): Promise<void>
  closeSession(sessionId: string): Promise<void>
}

export class InMemoryTranscriptStore implements TranscriptStore {
  private readonly entries = new Map<string, TranscriptEntry[]>()

  async append(entry: TranscriptEntry): Promise<void> {
    const current = this.entries.get(entry.sessionId) ?? []
    this.entries.set(entry.sessionId, [...current, entry])
  }

  async list(sessionId: string): Promise<TranscriptEntry[]> {
    return this.entries.get(sessionId) ?? []
  }
}

export class InMemoryExecutionLedger implements ExecutionLedger {
  private readonly events = new Map<string, LedgerEvent[]>()

  async append(event: LedgerEvent): Promise<void> {
    const current = this.events.get(event.runId) ?? []
    this.events.set(event.runId, [...current, event])
  }

  async listForRun(runId: string): Promise<LedgerEvent[]> {
    return this.events.get(runId) ?? []
  }
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, { ref: ArtifactRef; data?: unknown }>()
  private sequence = 0

  async write(
    artifact: Omit<ArtifactRef, 'artifactId'> & { artifactId?: string },
    data?: unknown,
  ): Promise<ArtifactRef> {
    this.sequence += 1
    const artifactId = artifact.artifactId ?? `artifact_${this.sequence}`
    const ref: ArtifactRef = {
      artifactId,
      artifactType: artifact.artifactType,
      path: artifact.path,
      hash: artifact.hash,
    }
    this.artifacts.set(artifactId, { ref, data })
    return ref
  }
}

export class InMemoryKernelPersistence implements KernelPersistence {
  readonly transcript = new InMemoryTranscriptStore()
  readonly ledger = new InMemoryExecutionLedger()
  readonly artifacts = new InMemoryArtifactStore()

  async flushCritical(_sessionId: string, _runId?: string): Promise<void> {
    return
  }

  async closeSession(_sessionId: string): Promise<void> {
    return
  }
}

function isNodeError(error: unknown): error is Error & { code?: string } {
  return error instanceof Error
}

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  let current = ''
  try {
    current = await readFile(filePath, 'utf8')
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error
    }
  }

  const line = `${JSON.stringify(value)}\n`
  await writeFile(filePath, `${current}${line}`, 'utf8')
}

async function readJsonLines<T>(filePath: string): Promise<T[]> {
  try {
    const contents = await readFile(filePath, 'utf8')
    return contents
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

function serializeArtifactData(data?: unknown): string {
  if (data === undefined) {
    return ''
  }

  if (typeof data === 'string') {
    return data
  }

  return JSON.stringify(data, null, 2)
}

function createContentHash(serialized: string): string | undefined {
  if (!serialized) {
    return undefined
  }

  return createHash('sha256').update(serialized).digest('hex')
}

export class FileTranscriptStore implements TranscriptStore {
  private readonly baseDir: string

  constructor(baseDir?: string) {
    this.baseDir = resolveStorageBaseDir(baseDir)
  }

  async append(entry: TranscriptEntry): Promise<void> {
    await appendJsonLine(
      getSessionTranscriptPath(entry.sessionId, this.baseDir),
      entry,
    )

    if (entry.runId) {
      await this.ensureRunDirectories(entry.runId)
      await appendJsonLine(getRunTranscriptPath(entry.runId, this.baseDir), entry)
    }
  }

  async list(sessionId: string): Promise<TranscriptEntry[]> {
    return readJsonLines<TranscriptEntry>(
      getSessionTranscriptPath(sessionId, this.baseDir),
    )
  }

  private async ensureRunDirectories(runId: string): Promise<void> {
    await Promise.all([
      mkdir(getRunLedgerDir(runId, this.baseDir), { recursive: true }),
      mkdir(getRunArtifactsDir(runId, this.baseDir), { recursive: true }),
      mkdir(getRunIndexesDir(runId, this.baseDir), { recursive: true }),
      mkdir(getRunCloseoutDir(runId, this.baseDir), { recursive: true }),
      mkdir(dirname(getRunTranscriptPath(runId, this.baseDir)), {
        recursive: true,
      }),
    ])
  }
}

export class FileExecutionLedger implements ExecutionLedger {
  private readonly baseDir: string

  constructor(baseDir?: string) {
    this.baseDir = resolveStorageBaseDir(baseDir)
  }

  async append(event: LedgerEvent): Promise<void> {
    await mkdir(getRunLedgerDir(event.runId, this.baseDir), { recursive: true })
    await mkdir(getRunArtifactsDir(event.runId, this.baseDir), {
      recursive: true,
    })
    await mkdir(getRunIndexesDir(event.runId, this.baseDir), {
      recursive: true,
    })
    await appendJsonLine(getRunLedgerEventsPath(event.runId, this.baseDir), event)
  }

  async listForRun(runId: string): Promise<LedgerEvent[]> {
    return readJsonLines<LedgerEvent>(getRunLedgerEventsPath(runId, this.baseDir))
  }
}

export class FileArtifactStore implements ArtifactStore {
  private readonly baseDir: string
  private sequence = 0

  constructor(baseDir?: string) {
    this.baseDir = resolveStorageBaseDir(baseDir)
  }

  async write(
    artifact: Omit<ArtifactRef, 'artifactId'> & { artifactId?: string },
    data?: unknown,
  ): Promise<ArtifactRef> {
    this.sequence += 1
    const artifactId = artifact.artifactId ?? `artifact_${this.sequence}`
    const outputPath = getArtifactAbsolutePath(artifact.path, this.baseDir)
    const serialized = serializeArtifactData(data)
    const hash = artifact.hash ?? createContentHash(serialized)

    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, serialized, 'utf8')

    return {
      artifactId,
      artifactType: artifact.artifactType,
      path: outputPath,
      hash,
    }
  }
}

export class FileKernelPersistence implements KernelPersistence {
  readonly transcript: TranscriptStore
  readonly ledger: ExecutionLedger
  readonly artifacts: ArtifactStore
  readonly baseDir: string

  constructor(baseDir?: string) {
    this.baseDir = resolveStorageBaseDir(baseDir)
    this.transcript = new FileTranscriptStore(this.baseDir)
    this.ledger = new FileExecutionLedger(this.baseDir)
    this.artifacts = new FileArtifactStore(this.baseDir)
  }

  async flushCritical(_sessionId: string, _runId?: string): Promise<void> {
    return
  }

  async closeSession(_sessionId: string): Promise<void> {
    return
  }
}
