/**
 * Identifier generation port.
 *
 * Internal identity is completely separate from `chequeNumber`: the id is a system
 * surrogate used for references, storage and sync, while the cheque number is a
 * human- and bank-facing STRING owned by a cheque book. They are never interchangeable.
 *
 * This port replaces the legacy `Date.now().toString() + Math.random().toString(36)`
 * pattern found at `packages/core/src/services/CheckService.ts:108`,
 * `BankAccountService.ts:51` and `printchecks/src/stores/check.ts:350`. That pattern
 * collides within the same millisecond, is not RFC-compliant, and is unreliable under
 * offline sync where two devices must not be able to mint the same id.
 */
export type IdentifierKind = 'bank' | 'bankAccount' | 'chequeBook' | 'cheque' | 'transaction'

export interface IdGenerator {
  /** Produce a new, globally unique identifier for the given kind of entity. */
  next(kind: IdentifierKind): string
}
