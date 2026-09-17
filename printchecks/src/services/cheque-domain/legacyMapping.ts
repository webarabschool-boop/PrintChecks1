import { Money } from '@printchecks/cheque-core'
import type { ChequeStatus } from '@printchecks/cheque-core'

/**
 * Legacy → domain mapping (Phase 1).
 *
 * This module is PURE: no storage, no clock, no randomness. The same legacy input
 * always produces the same domain output, which is what makes migration deterministic
 * and idempotent — re-running a migration reproduces byte-identical records and never
 * duplicates them.
 *
 * ## Deterministic identity
 *
 * Migrated records derive their domain ids from the legacy identity, under a dedicated
 * `…:legacy:` scheme:
 *
 *     bank:legacy:<normalised bank name>        one Bank per distinct bank name
 *     bankAccount:legacy:<legacy account id>    one BankAccount per legacy account
 *     chequeBook:legacy:<legacy account id>     one manual migration book per account
 *     cheque:legacy:<legacy check id>           one Cheque per legacy check
 *
 * Random ids (CryptoIdGenerator) are used for genuinely NEW domain records only; the
 * migration path never mints randomness, because idempotency requires replay-safety.
 *
 * ## What is NOT guessed
 *
 * - Currency. Legacy records carry no currency, and assuming one (a country, a bank,
 *   even a symbol seen elsewhere) would fabricate financial data. Migrated records use
 *   ISO 4217 `XXX` — the standard "no currency" code — an honest statement, never a
 *   guess. {@link LEGACY_MIGRATION_CURRENCY}
 * - Country, bank-specific formats, physical cheque geometry, MICR. Deferred entirely.
 * - Routing numbers / physical stock references. The domain schema has no home for
 *   them yet; the legacy records remain the untouched source of truth for that data.
 *
 * Records that cannot be mapped safely are reported in {@link MappingFailure} — the
 * original legacy record is left fully intact by the caller.
 */

/** Lossy-shape views of legacy records. Validation happens here, never type-asserted. */
export interface LegacyBankAccountShape {
  id?: unknown
  name?: unknown
  accountHolderName?: unknown
  accountNumber?: unknown
  accountType?: unknown
  isDefault?: unknown
  createdAt?: unknown
  updatedAt?: unknown
}

export interface LegacyCheckShape {
  id?: unknown
  checkNumber?: unknown
  amount?: unknown
  payTo?: unknown
  bankName?: unknown
  bankAccountNumber?: unknown
  date?: unknown
  memo?: unknown
  isVoid?: unknown
  isPrinted?: unknown
  createdAt?: unknown
  updatedAt?: unknown
}

export type MappableKind = 'bank' | 'bankAccount' | 'chequeBook' | 'cheque'

export interface MappingFailure {
  readonly kind: MappableKind
  readonly legacyId: string | null
  /** Stable, human-readable explanation of why the record was not mapped. */
  readonly reason: string
}

export type MappingResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: MappingFailure }

/**
 * ISO 4217 "no currency" code. Used for migrated records because the legacy data model
 * stores amounts without any currency, and inventing one would be a guess.
 */
export const LEGACY_MIGRATION_CURRENCY = 'XXX'

/** Label of the deterministic manual book that owns migrated cheque numbers. */
export const LEGACY_MIGRATION_BOOK_LABEL = 'Migrated legacy book'

// ---------------------------------------------------------------------------
// Deterministic identifiers
// ---------------------------------------------------------------------------

/**
 * Normalise a bank name for identity: trimmed, single-spaced, lower-cased.
 * Two legacy accounts that type the bank the same way share one Bank; two spellings
 * produce two Banks, which is faithful to the source data (we refuse to guess
 * name-equivalence beyond trivial formatting).
 */
export function normaliseBankName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const normalised = raw.trim().replace(/\s+/g, ' ').toLowerCase()
  return normalised.length > 0 ? normalised : null
}

export function legacyBankId(rawBankName: string): string {
  return `bank:legacy:${normaliseBankName(rawBankName) ?? rawBankName.trim()}`
}

export function legacyBankAccountId(legacyId: string): string {
  return `bankAccount:legacy:${legacyId}`
}

export function legacyMigrationChequeBookId(legacyAccountId: string): string {
  return `chequeBook:legacy:${legacyAccountId}`
}

export function legacyChequeId(legacyCheckId: string): string {
  return `cheque:legacy:${legacyCheckId}`
}

/**
 * Derive a deterministic internal bank code from the name. The domain requires a
 * non-empty code; it is a reference key, not display data, so upper-case alphanumeric
 * characters of the name are used (verbatim evidence), with a fixed fallback.
 */
export function deriveBankCode(normalisedName: string): string {
  const alnum = normalisedName.replace(/[^a-z0-9]/gi, '').toUpperCase()
  return (alnum.length > 0 ? alnum : 'LEGACY').slice(0, 12)
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/**
 * Normalise a legacy timestamp (Date instance or ISO string) to an exact ISO string.
 * Strings are preserved verbatim when parseable — no re-serialisation drift.
 */
export function toIsoTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isNaN(time) ? null : value.toISOString()
  }
  if (typeof value === 'string') {
    const time = Date.parse(value)
    return Number.isNaN(time) ? null : value
  }
  return null
}

// ---------------------------------------------------------------------------
// Cheque numbers, amounts, dates
// ---------------------------------------------------------------------------

/**
 * The legacy cheque number, validated as a STRING. Never parsed numerically: prefixes,
 * leading zeros, punctuation (`0012/2026-SB`) are preserved exactly. Only non-string
 * values and the obviously unusable (empty / whitespace / control characters — the
 * same rules as the domain's ChequeNumber value object) are rejected.
 */
export function mapLegacyChequeNumber(
  raw: unknown
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string } {
  if (typeof raw === 'number') {
    // A JSON datasource cannot trust a bare number: `04567` would already be gone.
    return { ok: false, reason: `check number arrived as a non-string value (${String(raw)})` }
  }
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'missing check number' }
  }
  if (raw.length === 0 || raw !== raw.trim() || raw.trim().length === 0) {
    return { ok: false, reason: `check number "${raw}" is empty or padded with whitespace` }
  }
  if (/\s/.test(raw)) {
    return { ok: false, reason: `check number "${raw}" contains whitespace` }
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(raw)) {
    return { ok: false, reason: 'check number contains control characters' }
  }
  if (raw.length > 64) {
    return { ok: false, reason: 'check number exceeds the domain maximum length' }
  }
  return { ok: true, value: raw }
}

const STRICT_THOUSANDS_PATTERN = /^[+-]?[0-9]{1,3}(,[0-9]{3})+(\.[0-9]+)?$/
const PLAIN_DECIMAL_PATTERN = /^[+-]?[0-9]+(\.[0-9]+)?$/

/**
 * Convert a legacy `string | number` amount into canonical core {@link Money}.
 *
 * String input is interpreted exactly (only grouped thousands separators are stripped,
 * and only when they are unambiguous). Number input is stringified — the legacy record
 * already held a float, so reproducing its shortest exact representation is faithful;
 * intentionally no rounding, scaling or float arithmetic is performed here, and the
 * result is built exclusively with `Money.fromDecimalString` (there is exactly one
 * Money implementation in this system).
 */
export function mapLegacyAmount(
  raw: unknown,
  currency: string = LEGACY_MIGRATION_CURRENCY
): { readonly ok: true; readonly value: Money } | { readonly ok: false; readonly reason: string } {
  let decimal: string | null = null

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      return { ok: false, reason: `amount is not a finite number (${String(raw)})` }
    }
    decimal = String(raw)
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (PLAIN_DECIMAL_PATTERN.test(trimmed)) {
      decimal = trimmed
    } else if (STRICT_THOUSANDS_PATTERN.test(trimmed)) {
      decimal = trimmed.replace(/,/g, '')
    }
  }

  if (decimal === null) {
    return { ok: false, reason: `unparseable amount (${typeof raw === 'string' ? `"${raw}"` : typeof raw})` }
  }

  try {
    return { ok: true, value: Money.fromDecimalString(decimal, currency) }
  } catch (error) {
    return {
      ok: false,
      reason: `amount "${decimal}" is not representable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/
const US_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/

/**
 * Interpret the legacy written-on-cheque date.
 *
 * The legacy writer produced `toLocaleDateString()` output in the app's en-US runtime
 * (e.g. `"9/17/2026"`). Passed-through ISO dates are kept verbatim; `m/d/yyyy` strings
 * are interpreted with that documented en-US convention — by pure pattern matching, so
 * the result never depends on the runtime locale. Anything else is left unmappable
 * rather than guessed.
 */
export function mapLegacyChequeDate(
  raw: unknown
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string } {
  if (raw instanceof Date) {
    const time = raw.getTime()
    if (Number.isNaN(time)) return { ok: false, reason: 'cheque date is an invalid Date' }
    return { ok: true, value: raw.toISOString().slice(0, 10) }
  }
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'missing cheque date' }
  }
  const trimmed = raw.trim()

  if (ISO_DATE_PATTERN.test(trimmed)) {
    const day = trimmed.slice(0, 10)
    return Number.isNaN(Date.parse(day)) ? { ok: false, reason: `invalid ISO cheque date "${day}"` } : { ok: true, value: day }
  }

  const us = US_DATE_PATTERN.exec(trimmed)
  if (us !== null) {
    const month = Number.parseInt(us[1] as string, 10)
    const dayOfMonth = Number.parseInt(us[2] as string, 10)
    const year = Number.parseInt(us[3] as string, 10)
    const candidate = new Date(Date.UTC(year, month - 1, dayOfMonth))
    const valid =
      candidate.getUTCFullYear() === year &&
      candidate.getUTCMonth() === month - 1 &&
      candidate.getUTCDate() === dayOfMonth
    if (!valid) return { ok: false, reason: `impossible calendar date "${trimmed}"` }
    const padded = `${us[3]}-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`
    return { ok: true, value: padded }
  }

  return { ok: false, reason: `unsupported cheque date format "${trimmed}"` }
}

// ---------------------------------------------------------------------------
// Entity mapping
// ---------------------------------------------------------------------------

/** Domain input bundles. `Book.reservedNumbers` is filled by the migration runner. */
export interface MappedLegacyAccount {
  readonly bank: {
    id: string
    code: string
    name: string
    country: string | null
    isActive: boolean
    createdAt: string
    updatedAt: string
  }
  readonly bankAccount: {
    id: string
    bankId: string
    holderName: string
    accountNumber: string
    currency: string
    accountType: string | null
    branchCode: string | null
    isDefault: boolean
    isActive: boolean
    createdAt: string
    updatedAt: string
  }
  readonly chequeBook: {
    id: string
    bankAccountId: string
    label: string
    createdAt: string
    updatedAt: string
  }
}

/** Map one legacy `bankAccounts[]` entry. */
export function mapLegacyBankAccount(
  legacy: LegacyBankAccountShape
): MappingResult<MappedLegacyAccount> {
  const failure = (reason: string): MappingResult<MappedLegacyAccount> => ({
    ok: false,
    failure: {
      kind: 'bankAccount',
      legacyId: typeof legacy.id === 'string' && legacy.id.length > 0 ? legacy.id : null,
      reason,
    },
  })

  if (typeof legacy.id !== 'string' || legacy.id.trim().length === 0) {
    return failure('missing legacy id (cannot form a deterministic domain id)')
  }
  const legacyId = legacy.id.trim()

  const bankName = typeof legacy.name === 'string' ? legacy.name.trim().replace(/\s+/g, ' ') : ''
  if (bankName.length === 0) {
    return failure('missing bank name (refusing to invent a Bank)')
  }

  if (typeof legacy.accountNumber !== 'string' || legacy.accountNumber.trim().length === 0) {
    return failure('missing account number (refusing to invent one)')
  }
  const accountNumber = legacy.accountNumber.trim()

  if (typeof legacy.accountHolderName !== 'string' || legacy.accountHolderName.trim().length === 0) {
    return failure('missing account holder name (refusing to invent one)')
  }
  const holderName = legacy.accountHolderName.trim()

  const createdAt = toIsoTimestamp(legacy.createdAt)
  if (createdAt === null) {
    return failure('missing or invalid createdAt timestamp')
  }
  const updatedAt = toIsoTimestamp(legacy.updatedAt) ?? createdAt

  const normalised = normaliseBankName(bankName) as string
  const bankId = legacyBankId(bankName)

  return {
    ok: true,
    value: {
      bank: {
        id: bankId,
        code: deriveBankCode(normalised),
        name: bankName,
        country: null,
        isActive: true,
        createdAt,
        updatedAt,
      },
      bankAccount: {
        id: legacyBankAccountId(legacyId),
        bankId,
        holderName,
        accountNumber,
        currency: LEGACY_MIGRATION_CURRENCY,
        accountType: typeof legacy.accountType === 'string' && legacy.accountType.trim().length > 0 ? legacy.accountType.trim() : null,
        branchCode: null,
        isDefault: legacy.isDefault === true,
        isActive: true,
        createdAt,
        updatedAt,
      },
      chequeBook: {
        id: legacyMigrationChequeBookId(legacyId),
        bankAccountId: legacyBankAccountId(legacyId),
        label: LEGACY_MIGRATION_BOOK_LABEL,
        createdAt,
        updatedAt,
      },
    },
  }
}

export interface MappedLegacyCheque {
  readonly cheque: {
    id: string
    chequeBookId: string
    bankAccountId: string
    chequeNumber: string
    chequeDate: string
    amount: Money
    payeeName: string
    drawerName: string | null
    memo: string | null
    createdAt: string
    updatedAt: string
  }
  /** Lifecycle replay: initial status is always `issued`; these transitions follow. */
  readonly transitions: ReadonlyArray<{ to: ChequeStatus; occurredAt: string; reason: string }>
}

/**
 * Map one legacy check to a domain Cheque pinned to the given migration book.
 *
 * Status semantics: `isPrinted` → `printed`; `isVoid` → `cancelled` (a legacy "void"
 * permanently consumes the physical cheque, matching the domain's terminal `cancelled`).
 * Both flags replay `issued → printed → cancelled`, staying inside the legal transition
 * table at every step; the append-only history keeps the legacy flags auditable.
 */
export function mapLegacyCheque(
  legacy: LegacyCheckShape,
  context: { chequeBookId: string; bankAccountId: string }
): MappingResult<MappedLegacyCheque> {
  const failure = (reason: string): MappingResult<MappedLegacyCheque> => ({
    ok: false,
    failure: {
      kind: 'cheque',
      legacyId: typeof legacy.id === 'string' && legacy.id.length > 0 ? legacy.id : null,
      reason,
    },
  })

  if (typeof legacy.id !== 'string' || legacy.id.trim().length === 0) {
    return failure('missing legacy id (cannot form a deterministic domain id)')
  }
  const legacyId = legacy.id.trim()

  const number = mapLegacyChequeNumber(legacy.checkNumber)
  if (!number.ok) return failure(number.reason)

  if (typeof legacy.payTo !== 'string' || legacy.payTo.trim().length === 0) {
    return failure('missing payee (payTo) — a cheque must name a payee')
  }

  const amount = mapLegacyAmount(legacy.amount)
  if (!amount.ok) return failure(amount.reason)

  const date = mapLegacyChequeDate(legacy.date)
  if (!date.ok) return failure(date.reason)

  const createdAt = toIsoTimestamp(legacy.createdAt)
  if (createdAt === null) {
    return failure('missing or invalid createdAt timestamp')
  }
  const updatedAt = toIsoTimestamp(legacy.updatedAt) ?? createdAt

  const transitions: Array<{ to: ChequeStatus; occurredAt: string; reason: string }> = []
  if (legacy.isPrinted === true) {
    transitions.push({ to: 'printed', occurredAt: updatedAt, reason: 'legacy isPrinted flag' })
  }
  if (legacy.isVoid === true) {
    transitions.push({ to: 'cancelled', occurredAt: updatedAt, reason: 'legacy isVoid flag (voided check)' })
  }

  return {
    ok: true,
    value: {
      cheque: {
        id: legacyChequeId(legacyId),
        chequeBookId: context.chequeBookId,
        bankAccountId: context.bankAccountId,
        chequeNumber: number.value,
        chequeDate: date.value,
        amount: amount.value,
        payeeName: legacy.payTo.trim(),
        drawerName: null,
        memo: typeof legacy.memo === 'string' && legacy.memo.trim().length > 0 ? legacy.memo.trim() : null,
        createdAt,
        updatedAt,
      },
      transitions,
    },
  }
}

// ---------------------------------------------------------------------------
// Matching legacy checks to legacy accounts
// ---------------------------------------------------------------------------

export interface LegacyAccountMatch {
  readonly kind: 'unique' | 'none' | 'ambiguous'
  readonly legacyAccount: LegacyBankAccountShape | null
  readonly candidates: readonly LegacyBankAccountShape[]
}

/**
 * Match a legacy check to exactly one legacy bank account.
 *
 * Comparison is by EXACT trimmed `bankAccountNumber` AND trimmed `bankName` — the two
 * pieces of identity a legacy check actually carries. Never numeric, never fuzzy:
 * a check for "00123" at "First National" must not silently attach itself to account
 * "123" at "First National Bank".
 */
export function matchLegacyAccountForCheck(
  legacy: LegacyCheckShape,
  accounts: readonly LegacyBankAccountShape[]
): LegacyAccountMatch {
  if (typeof legacy.bankAccountNumber !== 'string' || legacy.bankAccountNumber.trim().length === 0) {
    return { kind: 'none', legacyAccount: null, candidates: [] }
  }
  const number = legacy.bankAccountNumber.trim()
  const bankName = typeof legacy.bankName === 'string' ? legacy.bankName.trim().replace(/\s+/g, ' ') : null

  const candidates = accounts.filter((account) => {
    if (typeof account.accountNumber !== 'string' || account.accountNumber.trim() !== number) {
      return false
    }
    if (bankName === null) return true
    const accountBankName = typeof account.name === 'string' ? account.name.trim().replace(/\s+/g, ' ') : ''
    return accountBankName === bankName
  })

  if (candidates.length === 0) return { kind: 'none', legacyAccount: null, candidates }
  if (candidates.length === 1) return { kind: 'unique', legacyAccount: candidates[0] as LegacyBankAccountShape, candidates }

  // Deterministic tie-break: lexicographically smallest legacy id. Never random,
  // never "last write wins" — replays produce the same pairing every time.
  const sorted = [...candidates].sort((a, b) => String(a.id).localeCompare(String(b.id)))
  return { kind: 'ambiguous', legacyAccount: sorted[0] as LegacyBankAccountShape, candidates: sorted }
}
