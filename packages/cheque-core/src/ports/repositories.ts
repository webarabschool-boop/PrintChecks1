import type { Bank, BankAccount, ChequeBook, Cheque } from '../domain/entities/index'
import type { ChequeStatus } from '../domain/lifecycle/ChequeStatus'
import type { IsoTimestamp } from '../domain/entities/Bank'

/**
 * Repository ports.
 *
 * The application layer depends ONLY on these interfaces. Concrete adapters —
 * localStorage today, IndexedDB / SQL / HTTP API / sync later — live in
 * `infrastructure/` and are injected at composition time.
 *
 * This replaces the legacy pattern in which services reached directly into a
 * `StorageAdapter` and rewrote a whole collection as a single JSON blob
 * (`packages/core/src/services/CheckService.ts:52-80`). Per-record access plus a
 * unit of work is what makes a transactional backend possible at all.
 */

export interface SaveResult<T> {
  readonly entity: T
  /** True when a record with this id already existed and was overwritten. */
  readonly replaced: boolean
}

export interface BankRepository {
  save(bank: Bank): Promise<SaveResult<Bank>>
  findById(id: string): Promise<Bank | null>
  findByCode(code: string): Promise<Bank | null>
  /** All banks, most recently updated first unless the adapter cannot order. */
  findAll(): Promise<Bank[]>
  /** Only banks usable for new accounts. */
  findActive(): Promise<Bank[]>
  delete(id: string): Promise<boolean>
  count(): Promise<number>
}

export interface BankAccountRepository {
  save(account: BankAccount): Promise<SaveResult<BankAccount>>
  findById(id: string): Promise<BankAccount | null>
  findByBankId(bankId: string): Promise<BankAccount[]>
  /**
   * Lookup by the bank's own account number.
   *
   * Comparison is EXACT and case-sensitive; the value is never normalised numerically,
   * so leading zeros remain significant.
   */
  findByAccountNumber(bankId: string, accountNumber: string): Promise<BankAccount | null>
  findAll(): Promise<BankAccount[]>
  delete(id: string): Promise<boolean>
  count(): Promise<number>
}

export interface ChequeBookRepository {
  save(book: ChequeBook): Promise<SaveResult<ChequeBook>>
  findById(id: string): Promise<ChequeBook | null>
  findByBankAccountId(bankAccountId: string): Promise<ChequeBook[]>
  /** Books that can still issue cheques. */
  findIssuable(bankAccountId?: string): Promise<ChequeBook[]>
  findAll(): Promise<ChequeBook[]>
  delete(id: string): Promise<boolean>
  count(): Promise<number>

  /**
   * Whether this EXACT cheque number string is already used inside this book.
   *
   * Scoped to the book by design: the same number in a different book is legal and must
   * return `false`. Adapters SHOULD answer this from an index rather than by scanning,
   * and MUST compare strings exactly (no numeric coercion, no case folding).
   */
  hasChequeNumber(chequeBookId: string, chequeNumber: string): Promise<boolean>
}

export interface ChequeQuery {
  readonly chequeBookId?: string
  readonly bankAccountId?: string
  readonly direction?: 'outgoing' | 'incoming'
  readonly status?: ChequeStatus
  readonly payeeNameContains?: string
  readonly memoContains?: string
  /** Inclusive ISO date bounds on the cheque's own date, not on createdAt. */
  readonly dateFrom?: string
  readonly dateTo?: string
  /** Exact-match lookup on the cheque number STRING. Never a numeric range. */
  readonly chequeNumber?: string
}

export interface ChequeRepository {
  save(cheque: Cheque): Promise<SaveResult<Cheque>>
  findById(id: string): Promise<Cheque | null>
  /** Exact string lookup within one cheque book — the duplicate-detection query. */
  findByChequeBookAndNumber(chequeBookId: string, chequeNumber: string): Promise<Cheque | null>
  findByChequeBookId(chequeBookId: string): Promise<Cheque[]>
  findByBankAccountId(bankAccountId: string): Promise<Cheque[]>
  query(criteria: ChequeQuery): Promise<Cheque[]>
  findAll(): Promise<Cheque[]>
  delete(id: string): Promise<boolean>
  count(): Promise<number>
}

/**
 * A transactional scope over the cheque repositories.
 *
 * Every write performed through a unit of work either commits together or is discarded
 * together. This is the seam that lets a real database adapter make cheque issuance
 * atomic — advance-the-book and persist-the-cheque in one transaction — which a
 * whole-collection JSON blob could never do.
 */
export interface UnitOfWork {
  readonly banks: BankRepository
  readonly bankAccounts: BankAccountRepository
  readonly chequeBooks: ChequeBookRepository
  readonly cheques: ChequeRepository

  /** Persist everything done in this scope. Must be idempotent-safe to call once. */
  commit(): Promise<void>
  /** Discard everything done in this scope. */
  rollback(): Promise<void>
}

export interface UnitOfWorkFactory {
  begin(): Promise<UnitOfWork>

  /**
   * What this adapter can actually guarantee.
   *
   * Declared on the factory rather than probed at runtime so that use cases can state
   * the atomicity level they ran under, and so a weaker backend cannot pass itself off
   * as transactional.
   */
  readonly capabilities: TransactionCapabilities
}

/**
 * Declares how well an adapter can honour atomicity.
 *
 * Surfacing this explicitly is what prevents the localStorage limitation from being
 * hidden: callers and operators can see that a deployment is running without true
 * transactions instead of assuming safety.
 */
export type TransactionGuarantee =
  /** Backend supports real multi-record atomic transactions (SQL, IndexedDB). */
  | 'atomic'
  /** Writes are applied together but a crash mid-way can leave partial state. */
  | 'best-effort'
  /** No transactional support; each write is independent. */
  | 'none'

export interface TransactionCapabilities {
  readonly guarantee: TransactionGuarantee
  /** Human-readable note shown in diagnostics when the guarantee is weaker than `atomic`. */
  readonly limitation?: string
}

/** Read-only snapshot of what an adapter persisted, for diagnostics and audit. */
export interface PersistenceDiagnostics {
  readonly adapterName: string
  readonly capabilities: TransactionCapabilities
  readonly lastCommitAt: IsoTimestamp | null
}
