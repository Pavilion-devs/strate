import { resolve, join, isAbsolute } from 'path'
import { fileURLToPath } from 'url'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

export function getWalletAgentOsRoot(): string {
  return PACKAGE_ROOT
}

export function resolveStorageBaseDir(baseDir?: string): string {
  if (!baseDir) {
    return PACKAGE_ROOT
  }

  return isAbsolute(baseDir) ? baseDir : resolve(baseDir)
}

export function getSessionsDir(baseDir?: string): string {
  return join(resolveStorageBaseDir(baseDir), 'sessions')
}

export function getSessionDir(sessionId: string, baseDir?: string): string {
  return join(getSessionsDir(baseDir), sessionId)
}

export function getSessionStatePath(
  sessionId: string,
  baseDir?: string,
): string {
  return join(getSessionDir(sessionId, baseDir), 'session-state.json')
}

export function getSessionTranscriptPath(
  sessionId: string,
  baseDir?: string,
): string {
  return join(getSessionDir(sessionId, baseDir), 'transcript', 'transcript.jsonl')
}

export function getRunsDir(baseDir?: string): string {
  return join(resolveStorageBaseDir(baseDir), 'runs')
}

export function getWalletsDir(baseDir?: string): string {
  return join(resolveStorageBaseDir(baseDir), 'wallets')
}

export function getWalletDir(walletId: string, baseDir?: string): string {
  return join(getWalletsDir(baseDir), walletId)
}

export function getWalletStatePath(walletId: string, baseDir?: string): string {
  return join(getWalletDir(walletId, baseDir), 'wallet-state.json')
}

export function getSignerProfilesDir(baseDir?: string): string {
  return join(resolveStorageBaseDir(baseDir), 'signer-profiles')
}

export function getSignerProfileDir(
  signerProfileId: string,
  baseDir?: string,
): string {
  return join(getSignerProfilesDir(baseDir), signerProfileId)
}

export function getSignerProfileStatePath(
  signerProfileId: string,
  baseDir?: string,
): string {
  return join(getSignerProfileDir(signerProfileId, baseDir), 'signer-profile.json')
}

export function getRunDir(runId: string, baseDir?: string): string {
  return join(getRunsDir(baseDir), runId)
}

export function getRunManifestPath(runId: string, baseDir?: string): string {
  return join(getRunDir(runId, baseDir), 'run-manifest.json')
}

export function getRunTranscriptPath(runId: string, baseDir?: string): string {
  return join(getRunDir(runId, baseDir), 'transcript', 'transcript.jsonl')
}

export function getRunLedgerDir(runId: string, baseDir?: string): string {
  return join(getRunDir(runId, baseDir), 'ledger')
}

export function getRunLedgerEventsPath(
  runId: string,
  baseDir?: string,
): string {
  return join(getRunLedgerDir(runId, baseDir), 'events.jsonl')
}

export function getRunArtifactsDir(runId: string, baseDir?: string): string {
  return join(getRunLedgerDir(runId, baseDir), 'artifacts')
}

export function getRunIndexesDir(runId: string, baseDir?: string): string {
  return join(getRunLedgerDir(runId, baseDir), 'indexes')
}

export function getRunCloseoutDir(runId: string, baseDir?: string): string {
  return join(getRunDir(runId, baseDir), 'closeout')
}

export function getArtifactAbsolutePath(
  artifactPath: string,
  baseDir?: string,
): string {
  return isAbsolute(artifactPath)
    ? artifactPath
    : join(resolveStorageBaseDir(baseDir), artifactPath)
}
