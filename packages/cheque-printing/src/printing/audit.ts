/**
 * Print audit records — append-only, chained, and masked.
 *
 * §12.3 requires that every print, reprint, failure and reference-data change be attributable, and
 * §12.4 requires the trail to be tamper-evident. A record therefore carries the previous record's
 * hash, so rewriting history breaks the chain at the point of the rewrite. This is not
 * cryptography: a local hash chain in a browser detects casual edits and makes "did anyone touch
 * this?" answerable; it is not a defence against someone who can rewrite the whole store, and the
 * docs say so rather than implying more.
 */

import { canonicalJson } from '../canonical/canonicalJson'
import { hashString } from '../canonical/hash'

export const PRINT_AUDIT_ACTIONS = [
  'template.published',
  'template.versioned',
  'template.deactivated',
  'template.activated',
  'profile.created',
  'profile.updated',
  'calibration.recorded',
  'calibration.verified',
  'calibration.rejected',
  'testprint.generated',
  'job.created',
  'job.queued',
  'job.authorised',
  'job.rendered',
  'job.sent',
  'job.completed',
  'job.failed',
  'job.retried',
  'job.cancelled',
  'safety.acknowledged',
  'safety.blocked',
] as const

export type PrintAuditAction = (typeof PRINT_AUDIT_ACTIONS)[number]

export interface PrintAuditContext {
  readonly jobId?: string
  readonly chequeId?: string | null
  readonly chequeNumber?: string
  readonly templateId?: string
  readonly templateVersion?: number
  readonly templateHash?: string
  readonly layoutHash?: string
  readonly printerProfileId?: string
  readonly calibrationId?: string | null
  readonly calibrationFingerprint?: string | null
  readonly attempt?: number
  readonly isReprint?: boolean
  readonly reprintOfJobId?: string | null
  readonly transportId?: string | null
  readonly documentBytes?: number
  readonly documentHash?: string
  readonly actorId?: string | null
  readonly actorName?: string | null
}

export interface PrintAuditRecord {
  readonly id: string
  readonly sequence: number
  readonly occurredAt: string
  readonly action: PrintAuditAction
  readonly entityType: 'BankChequeTemplate' | 'PrinterProfile' | 'PrinterCalibration' | 'ChequePrintJob' | 'TestPage' | 'Safety'
  readonly entityId: string
  readonly reason?: string | null
  readonly context: PrintAuditContext
  /** Account numbers and payee data are summarised, never copied (§12.4 A5). */
  readonly values?: Readonly<Record<string, string | number | boolean | null>>
  readonly previousHash: string | null
  readonly integrityHash: string
}

export const GENESIS_HASH = '0'.repeat(16)

export interface AppendAuditInput {
  readonly id: string
  readonly occurredAt: string
  readonly action: PrintAuditAction
  readonly entityType: PrintAuditRecord['entityType']
  readonly entityId: string
  readonly reason?: string | null
  readonly context?: PrintAuditContext
  readonly values?: Record<string, string | number | boolean | null>
}

export function computeAuditHash(record: Omit<PrintAuditRecord, 'integrityHash'>): string {
  return hashString(canonicalJson(record))
}

export function appendAuditRecord(
  previous: PrintAuditRecord | null,
  input: AppendAuditInput
): PrintAuditRecord {
  const sequence = previous === null ? 1 : previous.sequence + 1
  const previousHash = previous === null ? GENESIS_HASH : previous.integrityHash
  const withoutHash: Omit<PrintAuditRecord, 'integrityHash'> = {
    id: input.id,
    sequence,
    occurredAt: input.occurredAt,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    // The context carries identifiers only — never payee or account text, which is what
    // `maskValues` protects in the free-form `values` bag.
    context: input.context ?? {},
    ...(input.values === undefined ? {} : { values: maskValues(input.values) }),
    previousHash,
  }
  return Object.freeze({ ...withoutHash, integrityHash: computeAuditHash(withoutHash) })
}

export interface ChainVerification {
  readonly ok: boolean
  readonly length: number
  readonly firstBrokenIndex: number | null
  readonly problems: readonly string[]
}

export function verifyAuditChain(records: readonly PrintAuditRecord[]): ChainVerification {
  const problems: string[] = []
  let firstBrokenIndex: number | null = null
  let previousHash: string | null = null

  records.forEach((record, index) => {
    const before = problems.length

    if (record.sequence !== index + 1) {
      problems.push(`record ${String(index)} claims sequence ${String(record.sequence)}`)
    }
    const expectedPrevious = previousHash === null ? GENESIS_HASH : previousHash
    if (record.previousHash !== expectedPrevious) {
      problems.push(
        `record "${record.id}" links to ${String(record.previousHash)} but the chain expects ${expectedPrevious}`
      )
    }
    const recomputed = computeAuditHash(withoutIntegrityHash(record))
    if (recomputed !== record.integrityHash) {
      problems.push(`record "${record.id}" content does not match its integrity hash — it was edited after the fact`)
    }

    if (problems.length > before && firstBrokenIndex === null) firstBrokenIndex = index
    previousHash = record.integrityHash
  })

  return Object.freeze({
    ok: problems.length === 0,
    length: records.length,
    firstBrokenIndex,
    problems: Object.freeze(problems),
  })
}

/** Copy without the self-referential field — recomputing a hash must not include the hash. */
function withoutIntegrityHash(record: PrintAuditRecord): Omit<PrintAuditRecord, 'integrityHash'> {
  const copy: Record<string, unknown> = { ...record }
  delete copy['integrityHash']
  return copy as Omit<PrintAuditRecord, 'integrityHash'>
}

/** `****1234` — enough to recognise an account, not enough to use it. */
export function maskAccountNumber(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length <= 4) return '*'.repeat(trimmed.length)
  return `${'*'.repeat(Math.max(4, trimmed.length - 4))}${trimmed.slice(-4)}`
}

const SENSITIVE_VALUE_KEYS = ['accountNumber', 'bankAccountNumber', 'iban', 'routingNumber', 'payeeName']

function maskValues(values: Record<string, string | number | boolean | null>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(values)) {
    if (SENSITIVE_VALUE_KEYS.includes(key) && typeof value === 'string') {
      out[key] = key === 'payeeName' ? `${value.slice(0, 2)}…` : maskAccountNumber(value)
      continue
    }
    out[key] = value
  }
  return out
}

/** Compact one-line description for a history list. */
export function describeAuditRecord(record: PrintAuditRecord): string {
  const target = `${record.entityType} ${record.entityId}`
  const pinned =
    record.context.templateId === undefined
      ? ''
      : ` [${record.context.templateId} v${String(record.context.templateVersion ?? '?')} / ${record.context.layoutHash ?? 'no hash'}]`
  return `${String(record.sequence).padStart(4, '0')} ${record.occurredAt} ${record.action} ${target}${pinned}`
}
