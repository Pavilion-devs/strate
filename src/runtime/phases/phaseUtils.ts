import type { ApprovalState } from '../../contracts/approval.js'

export function appendUnique(values: string[], value: string | undefined): string[] {
  if (!value || values.includes(value)) {
    return values
  }

  return [...values, value]
}

export function toEpochMillis(value: string | undefined): number | undefined {
  if (!value) {
    return undefined
  }

  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

export function isTimestampExpired(expiresAt: string | undefined, at: string): boolean {
  const expiryMillis = toEpochMillis(expiresAt)
  const atMillis = toEpochMillis(at)
  if (expiryMillis == null || atMillis == null) {
    return false
  }

  return atMillis >= expiryMillis
}

export function isTerminalApprovalStatus(status: ApprovalState['status']): boolean {
  return (
    status === 'approved' ||
    status === 'rejected' ||
    status === 'expired' ||
    status === 'invalidated'
  )
}
