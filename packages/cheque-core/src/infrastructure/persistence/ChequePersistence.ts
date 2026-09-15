import { Bank, type BankData } from '../../domain/entities/Bank'
import { BankAccount, type BankAccountData } from '../../domain/entities/BankAccount'
import { ChequeBook, type ChequeBookData } from '../../domain/entities/ChequeBook'
import { Cheque, type ChequeData } from '../../domain/entities/Cheque'
import type { IsoTimestamp } from '../../domain/entities/Bank'
import type {
  BankAccountRepository,
  BankRepository,
  ChequeBookRepository,
  ChequeQuery,
  ChequeRepository,
  PersistenceDiagnostics,
  SaveResult,
  TransactionCapabilities,
  UnitOfWork,
  UnitOfWorkFactory,
} from '../../ports/repositories'
import { InMemoryRecordStore, RECORD_STORE_CAPABILITIES, type RecordStore } from './RecordStore'

export type ChequeCollection = 'bank' | 'bankAccount' | 'chequeBook' | 'cheque'

const COLLECTIONS: readonly ChequeCollection[] = ['bank', 'bankAccount', 'chequeBook', 'cheque']

/**
 * Flush order, and it is load-bearing.
 *
 * A key/value store has no transactions, so a multi-record commit CAN fail part-way. The
 * order below makes the only reachable partial state a SAFE one:
 *
 *   - chequeBook is written BEFORE cheque. If the cheque write then fails, the book's
 *     sequence cursor has already advanced, leaving a GAP: a consumed number with no
 *     cheque against it. Auditable, harmless, and the number is never re-issued.
 *   - Writing the cheque first would be the opposite: a persisted cheque whose book never
 *     advanced, so the NEXT issuance would allocate the same number again — a duplicate
 *     cheque number inside one book, which is the one outcome this system must never allow.
 *
 * Banks and accounts are written first because a cheque references them; a dangling
 * reference is worse than a missing cheque.
 *
 * An adapter that reports `atomic` capability makes this ordering moot — everything
 * commits or nothing does. The ordering exists so that a `best-effort` backend still
 * fails safe.
 */
const COMMIT_ORDER: readonly ChequeCollection[] = ['bank', 'bankAccount', 'chequeBook', 'cheque']

export interface ChequePersistenceOptions {
  /**
   * Key namespace. Defaults to `printchecks:cheque:v1`.
   *
   * It intentionally does NOT collide with the legacy `printchecks:` collection keys used
   * by `packages/core` and `printchecks/src/stores`, so the new model can coexist with old
   * data during migration instead of overwriting it.
   */
  readonly namespace?: string
  readonly store?: RecordStore
  readonly capabilities?: TransactionCapabilities
}

/** Raised when a stored record cannot be deserialised. Never silently skipped. */
export class CorruptRecordError extends Error {
  readonly code = 'CORRUPT_RECORD'
  constructor(
    readonly key: string,
    readonly collection: string,
    readonly cause: unknown
  ) {
    super(
      `Stored ${collection} record at "${key}" could not be read: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`
    )
    this.name = 'CorruptRecordError'
  }
}

/** A consistent, isolated copy of every collection, taken when a unit of work begins. */
interface Snapshot {
  readonly banks: Map<string, Bank>
  readonly bankAccounts: Map<string, BankAccount>
  readonly chequeBooks: Map<string, ChequeBook>
  readonly cheques: Map<string, Cheque>
}

function cloneSnapshot(source: Snapshot): Snapshot {
  return {
    banks: new Map(source.banks),
    bankAccounts: new Map(source.bankAccounts),
    chequeBooks: new Map(source.chequeBooks),
    cheques: new Map(source.cheques),
  }
}

/**
 * Record-oriented persistence for the cheque domain.
 *
 * ## One record per key — no collection blobs
 *
 *     <namespace>:bank:<id>
 *     <namespace>:bankAccount:<id>
 *     <namespace>:chequeBook:<id>
 *     <namespace>:cheque:<id>
 *
 * Enumeration is done by scanning keys under the namespace. There is no collection-level
 * JSON blob and no id-list blob. This removes the legacy failure mode in which a single
 * corrupted or oversized `printchecks:checks` value destroyed every cheque at once
 * (`packages/core/src/services/CheckService.ts:52-80`), and it makes per-record conflict
 * resolution possible once sync is added.
 *
 * ## Snapshot isolation
 *
 * `begin()` hands out a COPY of the working set. Reads and writes inside the unit of work
 * touch only that copy, so `rollback()` genuinely discards everything — which is what lets
 * `IssueChequeUseCase` promise that a failed issuance leaves no trace. `commit()` diffs the
 * snapshot against the live set and flushes only the changed keys.
 *
 * Copying is O(n) per unit of work, which is appropriate at localStorage scale. A real
 * database adapter should implement `UnitOfWorkFactory` directly over BEGIN/COMMIT rather
 * than reusing this class — the port, not this implementation, is the contract.
 */
export class ChequePersistence implements UnitOfWorkFactory {
  readonly capabilities: TransactionCapabilities

  private readonly namespace: string
  private readonly store: RecordStore

  private readonly live: Snapshot = {
    banks: new Map(),
    bankAccounts: new Map(),
    chequeBooks: new Map(),
    cheques: new Map(),
  }

  private hydrated = false
  private lastCommitAt: IsoTimestamp | null = null

  constructor(options: ChequePersistenceOptions = {}) {
    this.namespace = options.namespace ?? 'printchecks:cheque:v1'
    this.store = options.store ?? new InMemoryRecordStore()
    this.capabilities = options.capabilities ?? RECORD_STORE_CAPABILITIES
  }

  /**
   * Load existing records from the underlying store.
   *
   * Idempotent. Called automatically by {@link begin}, but exposed so a host application
   * can await hydration explicitly and surface load failures to the user instead of
   * discovering them mid-issuance.
   *
   * @throws CorruptRecordError if any stored record fails to deserialise. Loading stops
   *         rather than silently dropping data.
   */
  async hydrate(force = false): Promise<void> {
    if (this.hydrated && !force) return

    if (force) {
      this.live.banks.clear()
      this.live.bankAccounts.clear()
      this.live.chequeBooks.clear()
      this.live.cheques.clear()
    }

    const keys = await this.store.keys()
    const prefix = `${this.namespace}:`

    for (const key of keys) {
      if (!key.startsWith(prefix)) continue

      const rest = key.slice(prefix.length)
      const separator = rest.indexOf(':')
      if (separator === -1) continue

      const collection = rest.slice(0, separator)
      if (!(COLLECTIONS as readonly string[]).includes(collection)) continue

      const raw = await this.store.get<unknown>(key)
      if (raw === null) continue

      try {
        this.applyLoaded(collection as ChequeCollection, raw)
      } catch (error) {
        throw new CorruptRecordError(key, collection, error)
      }
    }

    this.hydrated = true
  }

  private applyLoaded(collection: ChequeCollection, raw: unknown): void {
    switch (collection) {
      case 'bank': {
        const bank = Bank.fromJSON(raw as BankData)
        this.live.banks.set(bank.id, bank)
        return
      }
      case 'bankAccount': {
        const account = BankAccount.fromJSON(raw as BankAccountData)
        this.live.bankAccounts.set(account.id, account)
        return
      }
      case 'chequeBook': {
        const book = ChequeBook.fromJSON(raw as ChequeBookData)
        this.live.chequeBooks.set(book.id, book)
        return
      }
      case 'cheque': {
        const cheque = Cheque.fromJSON(raw as ChequeData)
        this.live.cheques.set(cheque.id, cheque)
        return
      }
    }
  }

  private keyFor(collection: ChequeCollection, id: string): string {
    return `${this.namespace}:${collection}:${id}`
  }

  async begin(): Promise<UnitOfWork> {
    await this.hydrate()
    return new ChequeUnitOfWork(cloneSnapshot(this.live), this)
  }

  diagnostics(): PersistenceDiagnostics {
    return {
      adapterName: 'ChequePersistence',
      capabilities: this.capabilities,
      lastCommitAt: this.lastCommitAt,
    }
  }

  /** Record counts, for diagnostics and tests. */
  counts(): Record<ChequeCollection, number> {
    return {
      bank: this.live.banks.size,
      bankAccount: this.live.bankAccounts.size,
      chequeBook: this.live.chequeBooks.size,
      cheque: this.live.cheques.size,
    }
  }

  /**
   * Diff a committed snapshot against the live set, apply it, and flush changed keys.
   *
   * @internal Called only by {@link ChequeUnitOfWork.commit}.
   */
  /**
   * Diff a committed snapshot against the live set, flush it, then apply it.
   *
   * Ordering matters: the live set is mutated ONLY after every write has succeeded. A
   * flush that fails part-way therefore leaves the in-memory view consistent with itself,
   * and we re-hydrate from the store so it also reflects what actually landed on disk.
   *
   * @internal Called only by {@link ChequeUnitOfWork.commit}.
   */
  async commitSnapshot(snapshot: Snapshot): Promise<void> {
    const changes = this.planChanges(snapshot)

    try {
      // Collected as thunks and awaited one at a time. Creating promises up front would
      // start every write immediately, so a failure could not stop the ones behind it.
      for (const change of changes) {
        await change.write()
      }
    } catch (error) {
      // Partial write: resync from the store so the live set matches reality, then report.
      await this.hydrate(true).catch(() => undefined)
      throw error
    }

    for (const change of changes) {
      change.apply()
    }

    this.lastCommitAt = new Date().toISOString()
  }

  /** A single pending insert/update/delete: how to write it, and how to apply it locally. */
  private planChanges(snapshot: Snapshot): PlannedChange[] {
    const byCollection: Record<ChequeCollection, Map<string, { id: string; toData(): unknown }>> = {
      bank: this.live.banks,
      bankAccount: this.live.bankAccounts,
      chequeBook: this.live.chequeBooks,
      cheque: this.live.cheques,
    }
    const snapshotByCollection: Record<ChequeCollection, Map<string, { id: string; toData(): unknown }>> = {
      bank: snapshot.banks,
      bankAccount: snapshot.bankAccounts,
      chequeBook: snapshot.chequeBooks,
      cheque: snapshot.cheques,
    }

    // Ordered by COMMIT_ORDER, not by object key order: see the note on that constant.
    return COMMIT_ORDER.flatMap((collection) =>
      this.planCollection(collection, byCollection[collection], snapshotByCollection[collection])
    )
  }

  private planCollection<T extends { id: string; toData(): unknown }>(
    collection: ChequeCollection,
    liveMap: Map<string, T>,
    snapshotMap: Map<string, T>
  ): PlannedChange[] {
    const changes: PlannedChange[] = []

    // Inserts and updates. Entities are immutable, so instance identity is a sound
    // change detector: a re-saved, untouched entity produces no write.
    for (const [id, entity] of snapshotMap) {
      if (liveMap.get(id) === entity) continue

      const key = this.keyFor(collection, id)
      const data = entity.toData()
      changes.push({
        write: () => this.store.set(key, data),
        apply: () => {
          liveMap.set(id, entity)
        },
      })
    }

    // Deletions: present live, absent from the snapshot.
    for (const id of [...liveMap.keys()]) {
      if (snapshotMap.has(id)) continue

      const key = this.keyFor(collection, id)
      changes.push({
        write: () => this.store.remove(key),
        apply: () => {
          liveMap.delete(id)
        },
      })
    }

    return changes
  }
}

interface PlannedChange {
  /** Persist this change. May throw; a throw aborts the whole flush. */
  write(): Promise<void>
  /** Reflect this change in the live in-memory set. Runs only after a full flush. */
  apply(): void
}

/**
 * Isolated unit of work over a snapshot.
 *
 * Reads and writes both operate on the private snapshot; nothing is visible to other units
 * of work or to the store until `commit()`.
 */
class ChequeUnitOfWork implements UnitOfWork {
  readonly banks: BankRepository
  readonly bankAccounts: BankAccountRepository
  readonly chequeBooks: ChequeBookRepository
  readonly cheques: ChequeRepository

  private settled = false

  constructor(
    private readonly snapshot: Snapshot,
    private readonly persistence: ChequePersistence
  ) {
    this.banks = new BankRepositoryImpl(snapshot, this)
    this.bankAccounts = new BankAccountRepositoryImpl(snapshot, this)
    this.chequeBooks = new ChequeBookRepositoryImpl(snapshot, this)
    this.cheques = new ChequeRepositoryImpl(snapshot, this)
  }

  /** @internal Used by the repository implementations bound to this unit. */
  ensureOpen(): void {
    if (this.settled) {
      throw new Error('This unit of work has already been committed or rolled back.')
    }
  }

  async commit(): Promise<void> {
    this.ensureOpen()
    this.settled = true
    // commitSnapshot flushes first and applies to the live set only on full success,
    // resyncing from the store if a write fails part-way. The snapshot is discarded
    // either way, so there is no extra cleanup to do here.
    await this.persistence.commitSnapshot(this.snapshot)
  }

  async rollback(): Promise<void> {
    if (this.settled) return
    this.settled = true
    this.snapshot.banks.clear()
    this.snapshot.bankAccounts.clear()
    this.snapshot.chequeBooks.clear()
    this.snapshot.cheques.clear()
  }
}

// ---------------------------------------------------------------------------
// Repository implementations
// ---------------------------------------------------------------------------

function byUpdatedAtDesc<T extends { updatedAt: string }>(items: T[]): T[] {
  return items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
}

/** Newest cheque date first; ties broken lexicographically on the cheque number STRING. */
function byChequeDateDesc(items: Cheque[]): Cheque[] {
  return items.sort((a, b) => {
    if (a.chequeDate !== b.chequeDate) return a.chequeDate < b.chequeDate ? 1 : -1
    const left = a.chequeNumberValue
    const right = b.chequeNumberValue
    return left < right ? -1 : left > right ? 1 : 0
  })
}

abstract class RepositoryBase {
  constructor(
    protected readonly snapshot: Snapshot,
    protected readonly uow: ChequeUnitOfWork
  ) {}
}

class BankRepositoryImpl extends RepositoryBase implements BankRepository {
  async save(bank: Bank): Promise<SaveResult<Bank>> {
    this.uow.ensureOpen()
    bank.validate()
    const replaced = this.snapshot.banks.has(bank.id)
    this.snapshot.banks.set(bank.id, bank)
    return { entity: bank, replaced }
  }

  async findById(id: string): Promise<Bank | null> {
    return this.snapshot.banks.get(id) ?? null
  }

  async findByCode(code: string): Promise<Bank | null> {
    for (const bank of this.snapshot.banks.values()) {
      if (bank.code === code) return bank
    }
    return null
  }

  async findAll(): Promise<Bank[]> {
    return byUpdatedAtDesc([...this.snapshot.banks.values()])
  }

  async findActive(): Promise<Bank[]> {
    return byUpdatedAtDesc([...this.snapshot.banks.values()].filter((bank) => bank.isActive))
  }

  async delete(id: string): Promise<boolean> {
    this.uow.ensureOpen()
    return this.snapshot.banks.delete(id)
  }

  async count(): Promise<number> {
    return this.snapshot.banks.size
  }
}

class BankAccountRepositoryImpl extends RepositoryBase implements BankAccountRepository {
  async save(account: BankAccount): Promise<SaveResult<BankAccount>> {
    this.uow.ensureOpen()
    account.validate()
    const replaced = this.snapshot.bankAccounts.has(account.id)
    this.snapshot.bankAccounts.set(account.id, account)
    return { entity: account, replaced }
  }

  async findById(id: string): Promise<BankAccount | null> {
    return this.snapshot.bankAccounts.get(id) ?? null
  }

  async findByBankId(bankId: string): Promise<BankAccount[]> {
    return byUpdatedAtDesc(
      [...this.snapshot.bankAccounts.values()].filter((account) => account.bankId === bankId)
    )
  }

  async findByAccountNumber(bankId: string, accountNumber: string): Promise<BankAccount | null> {
    for (const account of this.snapshot.bankAccounts.values()) {
      // Exact, case-sensitive string comparison. Never numerically coerced, so
      // "0012345" and "12345" remain distinct accounts.
      if (account.bankId === bankId && account.accountNumber === accountNumber) return account
    }
    return null
  }

  async findAll(): Promise<BankAccount[]> {
    return byUpdatedAtDesc([...this.snapshot.bankAccounts.values()])
  }

  async delete(id: string): Promise<boolean> {
    this.uow.ensureOpen()
    return this.snapshot.bankAccounts.delete(id)
  }

  async count(): Promise<number> {
    return this.snapshot.bankAccounts.size
  }
}

class ChequeBookRepositoryImpl extends RepositoryBase implements ChequeBookRepository {
  async save(book: ChequeBook): Promise<SaveResult<ChequeBook>> {
    this.uow.ensureOpen()
    book.validate()
    const replaced = this.snapshot.chequeBooks.has(book.id)
    this.snapshot.chequeBooks.set(book.id, book)
    return { entity: book, replaced }
  }

  async findById(id: string): Promise<ChequeBook | null> {
    return this.snapshot.chequeBooks.get(id) ?? null
  }

  async findByBankAccountId(bankAccountId: string): Promise<ChequeBook[]> {
    return byUpdatedAtDesc(
      [...this.snapshot.chequeBooks.values()].filter((book) => book.bankAccountId === bankAccountId)
    )
  }

  async findIssuable(bankAccountId?: string): Promise<ChequeBook[]> {
    return [...this.snapshot.chequeBooks.values()]
      .filter((book) => book.isIssuable)
      .filter((book) => bankAccountId === undefined || book.bankAccountId === bankAccountId)
      .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
  }

  async findAll(): Promise<ChequeBook[]> {
    return byUpdatedAtDesc([...this.snapshot.chequeBooks.values()])
  }

  async delete(id: string): Promise<boolean> {
    this.uow.ensureOpen()
    return this.snapshot.chequeBooks.delete(id)
  }

  async count(): Promise<number> {
    return this.snapshot.chequeBooks.size
  }

  async hasChequeNumber(chequeBookId: string, chequeNumber: string): Promise<boolean> {
    const book = this.snapshot.chequeBooks.get(chequeBookId)
    // The reserved set is authoritative for anything issued through the aggregate.
    if (book !== undefined && book.hasReserved(chequeNumber)) return true

    // Fall back to scanning this book's cheques, which covers imported or legacy records
    // whose numbers were never registered as reservations.
    for (const cheque of this.snapshot.cheques.values()) {
      if (cheque.chequeBookId === chequeBookId && cheque.chequeNumberValue === chequeNumber) {
        return true
      }
    }
    return false
  }
}

class ChequeRepositoryImpl extends RepositoryBase implements ChequeRepository {
  async save(cheque: Cheque): Promise<SaveResult<Cheque>> {
    this.uow.ensureOpen()
    cheque.validate()
    const replaced = this.snapshot.cheques.has(cheque.id)
    this.snapshot.cheques.set(cheque.id, cheque)
    return { entity: cheque, replaced }
  }

  async findById(id: string): Promise<Cheque | null> {
    return this.snapshot.cheques.get(id) ?? null
  }

  async findByChequeBookAndNumber(
    chequeBookId: string,
    chequeNumber: string
  ): Promise<Cheque | null> {
    for (const cheque of this.snapshot.cheques.values()) {
      // Exact string match: no numeric coercion, no trimming, no case folding.
      if (cheque.chequeBookId === chequeBookId && cheque.chequeNumberValue === chequeNumber) {
        return cheque
      }
    }
    return null
  }

  async findByChequeBookId(chequeBookId: string): Promise<Cheque[]> {
    return byChequeDateDesc(
      [...this.snapshot.cheques.values()].filter((cheque) => cheque.chequeBookId === chequeBookId)
    )
  }

  async findByBankAccountId(bankAccountId: string): Promise<Cheque[]> {
    return byChequeDateDesc(
      [...this.snapshot.cheques.values()].filter((cheque) => cheque.bankAccountId === bankAccountId)
    )
  }

  async query(criteria: ChequeQuery): Promise<Cheque[]> {
    return byChequeDateDesc([...this.snapshot.cheques.values()].filter((c) => matches(c, criteria)))
  }

  async findAll(): Promise<Cheque[]> {
    return byChequeDateDesc([...this.snapshot.cheques.values()])
  }

  async delete(id: string): Promise<boolean> {
    this.uow.ensureOpen()
    return this.snapshot.cheques.delete(id)
  }

  async count(): Promise<number> {
    return this.snapshot.cheques.size
  }
}

function matches(cheque: Cheque, criteria: ChequeQuery): boolean {
  if (criteria.chequeBookId !== undefined && cheque.chequeBookId !== criteria.chequeBookId) {
    return false
  }
  if (criteria.bankAccountId !== undefined && cheque.bankAccountId !== criteria.bankAccountId) {
    return false
  }
  if (criteria.direction !== undefined && cheque.direction !== criteria.direction) return false
  if (criteria.status !== undefined && cheque.status !== criteria.status) return false
  if (criteria.chequeNumber !== undefined && cheque.chequeNumberValue !== criteria.chequeNumber) {
    return false
  }
  if (criteria.dateFrom !== undefined && cheque.chequeDate < criteria.dateFrom) return false
  if (criteria.dateTo !== undefined && cheque.chequeDate > criteria.dateTo) return false

  if (criteria.payeeNameContains !== undefined) {
    const needle = criteria.payeeNameContains.trim().toLowerCase()
    if (needle.length > 0 && !cheque.payeeName.toLowerCase().includes(needle)) return false
  }
  if (criteria.memoContains !== undefined) {
    const needle = criteria.memoContains.trim().toLowerCase()
    if (needle.length > 0 && !(cheque.memo ?? '').toLowerCase().includes(needle)) return false
  }
  return true
}
