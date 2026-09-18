/**
 * The print job record.
 *
 * §8.7's most damning line is "`CheckPrintJob` declared at `types/check.ts:88`, zero usages": a type
 * that describes a print, and no code that ever fills one in. This is the record. It exists so that
 * six months from now somebody can answer *who printed cheque A0102, on which printer, with which
 * calibration, and what exactly came out* — and then reproduce it.
 *
 * That question has one hard requirement: the job stores the layout it printed, not a pointer to the
 * "current" template. Templates are versioned precisely so a reprint of an old job cannot silently
 * pick up a layout change.
 */

import { hashCanonical } from '../canonical/hash'
import { utf8ByteLength } from '../html/document'
import type { PrintLayout } from '../layout/types'
import { PrintJobTransitionError } from '../errors'

export type PrintJobStatus =
  | 'created'
  | 'queued'
  | 'authorised'
  | 'rendering'
  | 'sent'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Every stage before `sent` can still be stopped; after that the ink is on the paper. */
export const CANCELLABLE_STATUSES: readonly PrintJobStatus[] = ['created', 'queued', 'authorised', 'rendering']

export const TERMINAL_STATUSES: readonly PrintJobStatus[] = ['completed', 'cancelled']

const TRANSITIONS: Readonly<Record<PrintJobStatus, readonly PrintJobStatus[]>> = {
  created: ['queued', 'cancelled'],
  queued: ['authorised', 'rendering', 'failed', 'cancelled'],
  authorised: ['rendering', 'failed', 'cancelled'],
  rendering: ['sent', 'failed', 'cancelled'],
  sent: ['completed', 'failed'],
  completed: [],
  failed: ['queued', 'cancelled'],
  cancelled: [],
}

export interface PrintJobPin {
  readonly templateId: string
  readonly templateVersion: number
  readonly templateHash: string
  readonly layoutHash: string
  readonly printerProfileId: string
  /** `null` is a statement, not a gap: this print was made with no measured calibration. */
  readonly calibrationId: string | null
  readonly calibrationFingerprint: string | null
}

export interface PrintJobEvent {
  readonly at: string
  readonly status: PrintJobStatus
  readonly actorId?: string | null
  readonly note?: string | null
}

export interface ChequePrintJob {
  readonly id: string
  readonly chequeId: string | null
  readonly chequeNumber: string
  readonly status: PrintJobStatus
  readonly pin: PrintJobPin

  /** 0 for the first print, 1 for the first reprint — a ruined sheet still consumed a number. */
  readonly attempt: number
  readonly isReprint: boolean
  /** Which job this one replaces, when it is a reprint. */
  readonly reprintOfJobId: string | null

  readonly createdBy: string | null
  readonly authorizedBy: string | null
  readonly authorizationReason: string | null

  readonly createdAt: string
  readonly updatedAt: string
  readonly queuedAt: string | null
  readonly authorizedAt: string | null
  readonly sentAt: string | null
  readonly completedAt: string | null

  readonly failure: { readonly code: string; readonly message: string; readonly at: string } | null

  /** The exact geometry that was printed. A reprint must be reproducible without the registry. */
  readonly layout: PrintLayout
  readonly document: {
    readonly mimeType: 'text/html'
    readonly bytes: number
    readonly hash: string
    readonly runCount: number
  }

  readonly history: readonly PrintJobEvent[]
  readonly transportId: string | null
  readonly notes?: string | null

  /**
   * Integrity hash over every other field of this record. The audit chain proves the log was not
   * rewritten; this proves that the record in front of you is the one that was written — an edited
   * cheque number, a quietly changed `authorizedBy`, or a status advanced by hand has nowhere to
   * hide. Empty only on a record that was loaded from a store predating the hash.
   */
  readonly recordHash: string
}

/** The stored shape, named for the port that persists it. */
export type PrintJobRecord = ChequePrintJob

export interface CreatePrintJobInput {
  readonly id: string
  readonly chequeId: string | null
  readonly chequeNumber: string
  readonly layout: PrintLayout
  readonly printerProfileId: string
  readonly calibrationId: string | null
  readonly calibrationFingerprint: string | null
  readonly createdBy: string | null
  readonly createdAt?: string
  readonly notes?: string | null
  /** When reprinting, the job being replaced — drives `attempt` and `isReprint`. */
  readonly reprintOf?: ChequePrintJob
}

export function createPrintJob(input: CreatePrintJobInput): ChequePrintJob {
  const at = input.createdAt ?? new Date().toISOString()
  const previous = input.reprintOf ?? null
  if (previous !== null && previous.pin.templateId !== input.layout.templateId) {
    throw new Error(
      `reprint job targets template "${input.layout.templateId}" but the original printed "${previous.pin.templateId}"`
    )
  }
  const job: ChequePrintJob = {
    id: input.id,
    chequeId: input.chequeId,
    chequeNumber: input.chequeNumber,
    status: 'created',
    pin: {
      templateId: input.layout.templateId,
      templateVersion: input.layout.templateVersion,
      templateHash: input.layout.templateHash,
      layoutHash: input.layout.layoutHash,
      printerProfileId: input.printerProfileId,
      calibrationId: input.calibrationId,
      calibrationFingerprint: input.calibrationFingerprint,
    },
    attempt: previous === null ? 0 : previous.attempt + 1,
    isReprint: previous !== null,
    reprintOfJobId: previous === null ? null : previous.id,
    createdBy: input.createdBy,
    authorizedBy: null,
    authorizationReason: null,
    createdAt: at,
    updatedAt: at,
    queuedAt: null,
    authorizedAt: null,
    sentAt: null,
    completedAt: null,
    failure: null,
    layout: input.layout,
    document: {
      mimeType: 'text/html',
      bytes: 0,
      hash: '',
      runCount: input.layout.runCount,
    },
    history: [{ at, status: 'created', actorId: input.createdBy, note: previous === null ? null : `reprint of ${previous.id}` }],
    transportId: null,
    recordHash: '',
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  }
  return sealJob(job)
}

export function legalTransitions(status: PrintJobStatus): readonly PrintJobStatus[] {
  return TRANSITIONS[status]
}

export function canTransition(from: PrintJobStatus, to: PrintJobStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

export interface TransitionOptions {
  readonly at?: string
  readonly actorId?: string | null
  readonly note?: string | null
  /** Required to move out of `queued` when the job is a reprint. */
  readonly reason?: string | null
  readonly failure?: { readonly code: string; readonly message: string }
  readonly transportId?: string | null
  readonly document?: { readonly bytes: number; readonly hash: string }
}

/**
 * Advance a job. Returns a new frozen record — a job that has reached `sent` must never be
 * rewritable in place, because that is exactly the edit a print record is supposed to prevent.
 */
export function transitionJob(
  job: ChequePrintJob,
  to: PrintJobStatus,
  options: TransitionOptions = {}
): ChequePrintJob {
  if (!canTransition(job.status, to)) {
    throw new PrintJobTransitionError(job.id, job.status, to)
  }
  const at = options.at ?? new Date().toISOString()

  if (to === 'authorised' && (options.actorId === undefined || options.actorId === null || options.actorId === '')) {
    throw new PrintJobTransitionError(job.id, `${job.status} (no authorising actor)`, to)
  }
  if (to === 'authorised' && job.isReprint && (options.reason ?? '').trim() === '') {
    throw new PrintJobTransitionError(job.id, `${job.status} (a reprint needs a recorded reason)`, to)
  }

  const event: PrintJobEvent = {
    at,
    status: to,
    actorId: options.actorId ?? null,
    note: options.note ?? (to === 'authorised' ? (options.reason ?? null) : null),
  }

  const failure =
    to === 'failed'
      ? {
          code: options.failure?.code ?? 'PRINT_FAILED',
          message: options.failure?.message ?? 'the transport reported a failure without detail',
          at,
        }
      : null

  const next: ChequePrintJob = {
    ...job,
    status: to,
    updatedAt: at,
    history: [...job.history, event],
    failure,
    queuedAt: to === 'queued' ? at : job.queuedAt,
    authorizedAt: to === 'authorised' ? at : job.authorizedAt,
    sentAt: to === 'sent' ? at : job.sentAt,
    completedAt: to === 'completed' ? at : job.completedAt,
    authorizedBy: to === 'authorised' ? (options.actorId ?? null) : job.authorizedBy,
    authorizationReason:
      to === 'authorised' ? (options.reason ?? null) : job.authorizationReason,
    transportId: options.transportId ?? job.transportId,
    document:
      options.document === undefined
        ? job.document
        : { ...job.document, bytes: options.document.bytes, hash: options.document.hash },
  }

  return sealJob(next)
}

/** A failed job re-enters the queue as an explicit retry: attempt + 1, isReprint true. */
export function retryJob(
  job: ChequePrintJob,
  options: { readonly at?: string; readonly actorId?: string; readonly reason?: string } = {}
): ChequePrintJob {
  const at = options.at ?? new Date().toISOString()
  const retried: ChequePrintJob = {
    ...transitionJob(job, 'queued', { at, actorId: options.actorId ?? null, note: options.reason ?? 'retry' }),
    attempt: job.attempt + 1,
    isReprint: true,
    reprintOfJobId: job.reprintOfJobId ?? job.id,
    failure: null,
  }
  return sealJob(retried)
}

export function isCancellable(job: ChequePrintJob): boolean {
  return CANCELLABLE_STATUSES.includes(job.status)
}

export function isSettled(job: ChequePrintJob): boolean {
  return TERMINAL_STATUSES.includes(job.status) || job.status === 'failed'
}

/**
 * Recompute what a stored job *should* contain, so a record can be checked against the layout it
 * pins. A mismatch means the record was edited, the layout was regenerated with different data, or
 * someone rewrote history — all three worth stopping for.
 */
/** Hash over the whole record, with the hash field itself excluded. */
export function computeJobHash(job: ChequePrintJob): string {
  const unsigned: Record<string, unknown> = { ...job }
  delete unsigned['recordHash']
  return hashCanonical(unsigned)
}

/** Freeze a record and stamp it, so no construction path can forget the hash. */
function sealJob(job: ChequePrintJob): ChequePrintJob {
  return Object.freeze({ ...job, recordHash: computeJobHash(job) })
}

export function verifyJobRecord(job: ChequePrintJob): {
  readonly ok: boolean
  readonly problems: readonly string[]
} {
  const problems: string[] = []
  if (job.layout.layoutHash !== job.pin.layoutHash) {
    problems.push(
      `stored layoutHash ${job.pin.layoutHash} does not match the pinned layout ${job.layout.layoutHash}`
    )
  }
  if (job.layout.templateId !== job.pin.templateId) {
    problems.push('stored layout belongs to a different template than the job pins')
  }
  if (job.layout.templateVersion !== job.pin.templateVersion) {
    problems.push(
      `stored layout is v${String(job.layout.templateVersion)} but the job pins v${String(job.pin.templateVersion)}`
    )
  }
  if (job.document.hash !== '') {
    const recomputed = hashCanonical({ bytes: job.document.bytes, runCount: job.document.runCount })
    if (recomputed !== job.document.hash) {
      problems.push('document hash does not match the recorded size and run count')
    }
  }
  if (job.attempt > 0 && !job.isReprint) {
    problems.push('attempt is greater than zero but the job is not marked as a reprint')
  }
  if (job.recordHash !== '') {
    const recomputed = computeJobHash(job)
    if (recomputed !== job.recordHash) {
      problems.push('record hash does not match its contents — the stored job was edited after it was written')
    }
  }
  return { ok: problems.length === 0, problems }
}

export function documentFingerprint(html: string, runCount: number): { bytes: number; hash: string } {
  const bytes = utf8ByteLength(html)
  return { bytes, hash: hashCanonical({ bytes, runCount }) }
}
