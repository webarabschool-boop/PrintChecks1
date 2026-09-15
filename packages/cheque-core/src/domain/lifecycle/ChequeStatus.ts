import { InvalidChequeStatusTransitionError } from '../errors'

/**
 * Cheque lifecycle states.
 *
 * Kept to the minimum set required by the product definition. Additional states can be
 * introduced later by extending this union and adding a row to
 * {@link CHEQUE_STATUS_TRANSITIONS} — no entity or persistence change is required, which
 * is the point of driving the lifecycle from a data table rather than from conditionals.
 */
export type ChequeStatus =
  | 'draft'
  | 'issued'
  | 'printed'
  | 'presented'
  | 'cleared'
  | 'cancelled'
  | 'returned'

export const CHEQUE_STATUSES: readonly ChequeStatus[] = [
  'draft',
  'issued',
  'printed',
  'presented',
  'cleared',
  'cancelled',
  'returned',
] as const

/**
 * Legal transitions, expressed as data.
 *
 * Reading it as a table (rather than as `if` statements scattered across a model) keeps
 * the lifecycle auditable in one place and lets a host application inspect or override
 * policy without touching the entity.
 *
 * An empty array means a terminal state.
 */
export const CHEQUE_STATUS_TRANSITIONS: Readonly<Record<ChequeStatus, readonly ChequeStatus[]>> = {
  // A draft may be issued, or cancelled before it ever leaves the system.
  draft: ['issued', 'cancelled'],

  // An issued cheque may be printed, or cancelled (spoiled/never released).
  issued: ['printed', 'cancelled'],

  // A printed cheque may be presented to the bank, cancelled (e.g. stop payment
  // before presentation), or returned (e.g. misprint / spoiled stock discovered late).
  printed: ['presented', 'cancelled', 'returned'],

  // A presented cheque clears or is dishonoured; it may also be stopped.
  presented: ['cleared', 'returned', 'cancelled'],

  // Cleared funds can still be reversed by the paying bank.
  cleared: ['returned'],

  cancelled: [],
  returned: [],
}

/** Every status, with a flag for whether it ends the lifecycle. */
export function isTerminalStatus(status: ChequeStatus): boolean {
  return CHEQUE_STATUS_TRANSITIONS[status].length === 0
}

export function isChequeStatus(value: unknown): value is ChequeStatus {
  return typeof value === 'string' && (CHEQUE_STATUSES as readonly string[]).includes(value)
}

/** The statuses reachable from `from`. */
export function allowedTransitions(from: ChequeStatus): readonly ChequeStatus[] {
  return CHEQUE_STATUS_TRANSITIONS[from]
}

/** Whether `from -> to` is legal. */
export function canTransition(from: ChequeStatus, to: ChequeStatus): boolean {
  return allowedTransitions(from).includes(to)
}

/**
 * Assert a transition is legal.
 *
 * @throws InvalidChequeStatusTransitionError when it is not.
 */
export function assertTransition(from: ChequeStatus, to: ChequeStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidChequeStatusTransitionError(from, to, allowedTransitions(from))
  }
}

/** One immutable entry in a cheque's lifecycle history. */
export interface ChequeStatusEntry {
  readonly from: ChequeStatus | null
  readonly to: ChequeStatus
  readonly occurredAt: string
  readonly reason?: string
  readonly actorId?: string
}

/**
 * Append an entry to a history array, returning a NEW array.
 *
 * The history is append-only by construction: this module exposes no update or delete
 * operation, so `Cheque.status` can always be re-derived from the last entry and a past
 * state can never be silently overwritten. This is the mechanism that replaces the
 * legacy unrestricted mutable field at `packages/core/src/models/Check.ts:186,197`.
 */
export function appendStatusEntry(
  history: readonly ChequeStatusEntry[],
  entry: ChequeStatusEntry
): readonly ChequeStatusEntry[] {
  return Object.freeze([...history, Object.freeze(entry)])
}

/** Derive the current status from a history, or `null` for an empty history. */
export function statusFromHistory(history: readonly ChequeStatusEntry[]): ChequeStatus | null {
  if (history.length === 0) return null
  const last = history[history.length - 1]
  return last ? last.to : null
}
