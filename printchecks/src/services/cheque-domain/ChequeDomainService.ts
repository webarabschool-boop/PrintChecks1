import {
  Bank,
  BankAccount,
  Cheque,
  ChequeBook,
  ChequeCore,
  ChequePersistence,
  Money,
} from '@printchecks/cheque-core'
import type {
  ChequeStatus,
  IssueChequeResult,
  PersistenceDiagnostics,
  RecordStore,
  TransactionGuarantee,
} from '@printchecks/cheque-core'

import { SecureStorageRecordStore } from './persistence/SecureStorageRecordStore'
import { createSecureStorageLegacySource, type LegacyDataSource } from './legacySource'
import {
  matchLegacyAccountForCheck,
  mapLegacyBankAccount,
  mapLegacyCheque,
  type LegacyBankAccountShape,
  type LegacyCheckShape,
  type MappedLegacyAccount,
  type MappingFailure,
} from './legacyMapping'

/**
 * ChequeDomainService — the application boundary between the legacy Vue application
 * and `@printchecks/cheque-core`.
 *
 * ## What this is
 *
 * The ONLY module in the Vue application that talks to the canonical domain core.
 * Everything above it (stores, views, components) sees plain application concepts and
 * never imports the core package directly. Below it, the core's rules are the single
 * source of truth: Bank → BankAccount → ChequeBook → Cheque, with the ChequeBook
 * owning cheque-number sequencing.
 *
 * ## What this is NOT
 *
 * Not a printing layer. Not a template engine. It models and persists cheque-domain
 * records only — physical layout, MICR and printer geometry are deliberately absent
 * (see docs/ARCHITECTURE.md §13/§15 for why those are deferred).
 *
 * ## Money at the boundary
 *
 * Amounts enter as the canonical core {@link Money} value object, or as an exact
 * `{ decimal, currency }` pair that is converted with `Money.fromDecimalString`.
 * Raw floats are not accepted: there is one Money implementation and it lives in the
 * core. Legacy (currency-less) records are mapped with ISO 4217 `XXX` ("no currency")
 * by the migration module — an explicit sentinel, never a guess.
 */

/** Exact amount input accepted by the boundary. No floating point. */
export type BoundaryMoneyInput = Money | { readonly decimal: string; readonly currency: string }

export interface CreateBankBoundaryInput {
  readonly code: string
  readonly name: string
  readonly nameLocal?: string | null
  readonly country?: string | null
  readonly isActive?: boolean
}

export interface CreateBankAccountBoundaryInput {
  readonly bankId: string
  readonly holderName: string
  readonly accountNumber: string
  /** Required for new records — the caller must make an explicit choice. */
  readonly currency: string
  readonly accountType?: string | null
  readonly branchCode?: string | null
  readonly isDefault?: boolean
  readonly isActive?: boolean
}

export interface ChequeBookSequenceConfig {
  readonly prefix?: string
  readonly startSequence?: number
  readonly currentSequence?: number
  readonly endSequence?: number | null
  readonly sequenceMode?: 'numeric' | 'alphanumeric' | 'manual'
  readonly sequenceWidth?: number | null
}

export interface CreateChequeBookBoundaryInput {
  readonly bankAccountId: string
  readonly label: string
  readonly stockReference?: string | null
  readonly sequence?: ChequeBookSequenceConfig
}

export interface IssueChequeBoundaryInput {
  readonly chequeBookId: string
  readonly payeeName: string
  readonly amount: BoundaryMoneyInput
  readonly chequeDate?: string
  readonly memo?: string | null
  readonly reference?: string | null
  /** Required for manual books; forbidden for automatic ones. Exact string, never parsed. */
  readonly chequeNumber?: string | null
  readonly initialStatus?: ChequeStatus
}

export interface IssueChequeBoundaryResult {
  readonly chequeId: string
  readonly chequeNumber: string
  readonly bankAccountId: string
  readonly bankId: string
  readonly transactionGuarantee: TransactionGuarantee
}

// ---------------------------------------------------------------------------
// Migration reporting
// ---------------------------------------------------------------------------

export interface EntityMigrationCounts {
  readonly created: number
  /** A record with this deterministic id existed with different content. */
  readonly replaced: number
  /** A byte-identical record already existed — the idempotency no-op. */
  readonly unchanged: number
}

export interface MigrationReport {
  readonly legacy: { readonly bankAccounts: number; readonly checks: number }
  readonly banks: EntityMigrationCounts
  readonly bankAccounts: EntityMigrationCounts
  readonly chequeBooks: EntityMigrationCounts
  readonly cheques: EntityMigrationCounts
  readonly failures: readonly MappingFailure[]
  readonly warnings: readonly string[]
}

export type SyncLegacyCheckResult =
  | {
      readonly ok: true
      readonly chequeId: string
      readonly chequeNumber: string
      readonly state: 'created' | 'replaced' | 'unchanged'
    }
  | { readonly ok: false; readonly failure: MappingFailure }

export interface ChequeDomainDiagnostics {
  readonly persistence: PersistenceDiagnostics
  readonly counts: { bank: number; bankAccount: number; chequeBook: number; cheque: number } | null
}

export interface ChequeDomainServiceOptions {
  readonly core: ChequeCore
  readonly legacySource: LegacyDataSource
  /** Used by clearDomainData() for the reversible-removal path. */
  readonly recordStore: RecordStore
  /**
   * Domain key namespace. Used by clearDomainData() to confine removal strictly to
   * domain records. Defaults to the cheque-core ChequePersistence default namespace;
   * pass the same value here whenever the persistence layer is configured with a
   * custom one.
   */
  readonly namespace?: string
}

function toMoney(input: BoundaryMoneyInput): Money {
  if (input instanceof Money) return input
  return Money.fromDecimalString(input.decimal, input.currency)
}

type MutableEntityMigrationCounts = {
  -readonly [K in keyof EntityMigrationCounts]: EntityMigrationCounts[K]
}

function emptyCounts(): MutableEntityMigrationCounts {
  return { created: 0, replaced: 0, unchanged: 0 }
}

function deepEqualJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export class ChequeDomainService {
  private readonly core: ChequeCore
  private readonly legacySource: LegacyDataSource
  private readonly recordStore: RecordStore
  private readonly namespacePrefix: string

  constructor(options: ChequeDomainServiceOptions) {
    this.core = options.core
    this.legacySource = options.legacySource
    this.recordStore = options.recordStore
    this.namespacePrefix = `${options.namespace ?? 'printchecks:cheque:v1'}:`
  }

  // ---------------------------------------------------------------------------
  // Canonical entity operations (delegates to the composition root)
  // ---------------------------------------------------------------------------

  async createBank(input: CreateBankBoundaryInput): Promise<Bank> {
    return this.core.createBank(input)
  }

  async createBankAccount(input: CreateBankAccountBoundaryInput): Promise<BankAccount> {
    return this.core.createBankAccount(input)
  }

  async createChequeBook(input: CreateChequeBookBoundaryInput): Promise<ChequeBook> {
    return this.core.createChequeBook(input)
  }

  /** The number this book would issue next, WITHOUT consuming it. Exact string. */
  async peekNextChequeNumber(chequeBookId: string): Promise<string> {
    const unitOfWork = await this.core.unitOfWorkFactory.begin()
    try {
      const book = await unitOfWork.chequeBooks.findById(chequeBookId)
      if (book === null) {
        throw new Error(`ChequeBook "${chequeBookId}" was not found in the domain store`)
      }
      return book.peekNextChequeNumber().value
    } finally {
      await unitOfWork.rollback().catch(() => undefined)
    }
  }

  /**
   * Issue a cheque through the canonical use case: the owning book allocates the
   * number (manual books take the operator's exact string), duplicate detection is
   * scoped to that book, and the cheque + advanced cursor commit in one unit of work.
   */
  async issueCheque(input: IssueChequeBoundaryInput): Promise<IssueChequeBoundaryResult> {
    const result: IssueChequeResult = await this.core.issueCheque({
      chequeBookId: input.chequeBookId,
      payeeName: input.payeeName,
      amount: toMoney(input.amount),
      chequeDate: input.chequeDate,
      memo: input.memo ?? null,
      reference: input.reference ?? null,
      drawerName: null,
      chequeNumber: input.chequeNumber ?? null,
      initialStatus: input.initialStatus,
      actorId: null,
    })
    return {
      chequeId: result.cheque.id,
      chequeNumber: result.chequeNumber,
      bankAccountId: result.bankAccountId,
      bankId: result.bankId,
      transactionGuarantee: result.transactionGuarantee,
    }
  }

  /** Move a cheque through its lifecycle (append-only history). */
  async transitionCheque(
    chequeId: string,
    status: ChequeStatus,
    meta: { reason?: string; actorId?: string } = {}
  ): Promise<Cheque> {
    return this.core.transitionCheque(chequeId, status, meta)
  }

  /** Duplicate check scoped to ONE book — the exact string, never coerced. */
  async hasChequeNumber(chequeBookId: string, chequeNumber: string): Promise<boolean> {
    const unitOfWork = await this.core.unitOfWorkFactory.begin()
    try {
      return await unitOfWork.chequeBooks.hasChequeNumber(chequeBookId, chequeNumber)
    } finally {
      await unitOfWork.rollback().catch(() => undefined)
    }
  }

  // ---------------------------------------------------------------------------
  // Read helpers
  // ---------------------------------------------------------------------------

  async listBanks(): Promise<readonly Bank[]> {
    const unitOfWork = await this.core.unitOfWorkFactory.begin()
    try {
      return await unitOfWork.banks.findAll()
    } finally {
      await unitOfWork.rollback().catch(() => undefined)
    }
  }

  async listBankAccounts(bankId?: string): Promise<readonly BankAccount[]> {
    const unitOfWork = await this.core.unitOfWorkFactory.begin()
    try {
      return bankId === undefined
        ? await unitOfWork.bankAccounts.findAll()
        : await unitOfWork.bankAccounts.findByBankId(bankId)
    } finally {
      await unitOfWork.rollback().catch(() => undefined)
    }
  }

  async findBankAccount(bankAccountId: string): Promise<BankAccount | null> {
    const unitOfWork = await this.core.unitOfWorkFactory.begin()
    try {
      return await unitOfWork.bankAccounts.findById(bankAccountId)
    } finally {
      await unitOfWork.rollback().catch(() => undefined)
    }
  }

  async listChequeBooks(bankAccountId?: string): Promise<readonly ChequeBook[]> {
    const unitOfWork = await this.core.unitOfWorkFactory.begin()
    try {
      return bankAccountId === undefined
        ? await unitOfWork.chequeBooks.findAll()
        : await unitOfWork.chequeBooks.findByBankAccountId(bankAccountId)
    } finally {
      await unitOfWork.rollback().catch(() => undefined)
    }
  }

  async findChequeBook(chequeBookId: string): Promise<ChequeBook | null> {
    return this.core.findChequeBook(chequeBookId)
  }

  async listCheques(chequeBookId?: string): Promise<readonly Cheque[]> {
    const unitOfWork = await this.core.unitOfWorkFactory.begin()
    try {
      return chequeBookId === undefined
        ? await unitOfWork.cheques.findAll()
        : await unitOfWork.cheques.findByChequeBookId(chequeBookId)
    } finally {
      await unitOfWork.rollback().catch(() => undefined)
    }
  }

  async findCheque(chequeId: string): Promise<Cheque | null> {
    return this.core.findCheque(chequeId)
  }

  // ---------------------------------------------------------------------------
  // Legacy migration — deterministic, idempotent, non-destructive, reversible
  // ---------------------------------------------------------------------------

  /**
   * Migrate the full legacy snapshot (`bankAccounts`, `checkList`) into the domain
   * namespace. Legacy keys are read but NEVER written. Re-running produces identical
   * records (all ids and timestamps are derived from the legacy data), so it is safe
   * to run repeatedly and after every legacy write.
   */
  async migrateLegacyChequeData(): Promise<MigrationReport> {
    const snapshot = await this.legacySource.load()
    const { report } = await this.runMigration(snapshot.bankAccounts, snapshot.checks)
    return report
  }

  /**
   * Mirror ONE legacy check (the store's save path) into the domain. Uses the same
   * deterministic mapping as the full migration, so it is idempotent on repeat saves.
   */
  async syncLegacyCheck(legacyCheck: LegacyCheckShape): Promise<SyncLegacyCheckResult> {
    const snapshot = await this.legacySource.load()
    const { report, chequeStates } = await this.runMigration(snapshot.bankAccounts, [legacyCheck])

    const legacyId = typeof legacyCheck.id === 'string' && legacyCheck.id.trim().length > 0 ? legacyCheck.id.trim() : null
    const state = legacyId === null ? undefined : chequeStates.get(`cheque:legacy:${legacyId}`)
    if (legacyId !== null && state !== undefined) {
      const chequeNumber = typeof legacyCheck.checkNumber === 'string' ? legacyCheck.checkNumber : ''
      return { ok: true, chequeId: `cheque:legacy:${legacyId}`, chequeNumber, state }
    }

    const failure = report.failures.find((f) => f.kind === 'cheque' && f.legacyId === legacyId)
    return {
      ok: false,
      failure: failure ?? {
        kind: 'cheque',
        legacyId,
        reason: 'the legacy check could not be mirrored (see migration report)',
      },
    }
  }

  /**
   * Remove EVERY record under the domain namespace and nothing else. This is the
   * reverse of migration: legacy data is untouched, and re-running the migration
   * statement rebuilds the identical domain state. Removal is confined to the
   * namespace prefix even if the underlying store enumerates a wider key space.
   */
  async clearDomainData(): Promise<number> {
    const keys = (await this.recordStore.keys()).filter((key) => key.startsWith(this.namespacePrefix))
    for (const key of keys) {
      await this.recordStore.remove(key)
    }
    // Force the persistence layer to drop its cached view so subsequent reads reflect
    // the removal instead of the pre-clear snapshot.
    if (this.core.unitOfWorkFactory instanceof ChequePersistence) {
      await this.core.unitOfWorkFactory.hydrate(true)
    }
    return keys.length
  }

  diagnostics(): ChequeDomainDiagnostics {
    const persistence = this.core.diagnostics()
    return {
      persistence,
      counts:
        this.core.unitOfWorkFactory instanceof ChequePersistence
          ? this.core.unitOfWorkFactory.counts()
          : null,
    }
  }

  /** The atomicity statement for the underlying persistence, for diagnostics screens. */
  transactionGuaranteeDescription(): string {
    return this.core.transactionGuaranteeDescription()
  }

  // ---------------------------------------------------------------------------
  // Migration engine
  // ---------------------------------------------------------------------------

  private async runMigration(
    legacyAccounts: readonly LegacyBankAccountShape[],
    legacyChecks: readonly LegacyCheckShape[]
  ): Promise<{ report: MigrationReport; chequeStates: Map<string, 'created' | 'replaced' | 'unchanged'> }> {
    const failures: MappingFailure[] = []
    const warnings: string[] = []
    const chequeStates = new Map<string, 'created' | 'replaced' | 'unchanged'>()

    const unitOfWork = await this.core.unitOfWorkFactory.begin()
    try {
      // ---- Accounts: map + save banks/accounts, defer books until reserved numbers
      // are known (they are the union of mapped cheque numbers scoped to the book).
      const mappedByLegacyId = new Map<string, MappedLegacyAccount>()
      const plannedBankIds = new Set<string>()
      const counts = {
        banks: emptyCounts(),
        bankAccounts: emptyCounts(),
        chequeBooks: emptyCounts(),
        cheques: emptyCounts(),
      }

      const reservedByBookId = new Map<string, string[]>()

      for (const legacyAccount of legacyAccounts) {
        const mapped = mapLegacyBankAccount(legacyAccount)
        if (!mapped.ok) {
          failures.push(mapped.failure)
          continue
        }
        const value = mapped.value
        const legacyAccountId = (legacyAccount.id as string).trim()
        mappedByLegacyId.set(legacyAccountId, value)
        reservedByBookId.set(value.chequeBook.id, [])

        if (!plannedBankIds.has(value.bank.id)) {
          plannedBankIds.add(value.bank.id)
          const bank = Bank.create({ ...value.bank, nameLocal: null })
          await this.saveCounted(unitOfWork.banks, bank, counts.banks)
        }

        const account = BankAccount.create(value.bankAccount)
        await this.saveCounted(unitOfWork.bankAccounts, account, counts.bankAccounts)
      }

      // ---- Checks: match to a mapped account, map, save cheques, and accumulate the
      // exact strings of consumed numbers per book.
      const seenLegacyChequeIds = new Set<string>()

      for (const legacyCheck of legacyChecks) {
        const legacyId = typeof legacyCheck.id === 'string' ? legacyCheck.id.trim() : null
        if (legacyId !== null) {
          if (seenLegacyChequeIds.has(legacyId)) {
            warnings.push(`duplicate legacy check id "${legacyId}" — the deterministic id maps both to one Cheque`)
          }
          seenLegacyChequeIds.add(legacyId)
        }

        const match = matchLegacyAccountForCheck(legacyCheck, legacyAccounts)
        if (match.kind === 'none') {
          failures.push({
            kind: 'cheque',
            legacyId,
            reason: 'no legacy bank account matches this check (exact account number + bank name)',
          })
          continue
        }
        if (match.kind === 'ambiguous') {
          warnings.push(
            `legacy check "${legacyId ?? '?'}" matched ${match.candidates.length} accounts; ` +
              `paired deterministically with "${String(match.legacyAccount?.id)}"`
          )
        }

        const matchedLegacyId = String(match.legacyAccount?.id ?? '').trim()
        const mappedAccount = mappedByLegacyId.get(matchedLegacyId)
        if (mappedAccount === undefined) {
          failures.push({
            kind: 'cheque',
            legacyId,
            reason: `the matching legacy bank account "${matchedLegacyId}" could not itself be mapped`,
          })
          continue
        }

        const mapped = mapLegacyCheque(legacyCheck, {
          chequeBookId: mappedAccount.chequeBook.id,
          bankAccountId: mappedAccount.bankAccount.id,
        })
        if (!mapped.ok) {
          failures.push(mapped.failure)
          continue
        }

        const input = mapped.value.cheque
        let cheque = Cheque.create({
          id: input.id,
          direction: 'outgoing',
          chequeBookId: input.chequeBookId,
          bankAccountId: input.bankAccountId,
          chequeNumber: input.chequeNumber,
          chequeDate: input.chequeDate,
          amount: input.amount,
          payeeName: input.payeeName,
          drawerName: input.drawerName,
          issuingBankName: null,
          memo: input.memo,
          reference: null,
          initialStatus: 'issued',
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
          createdBy: null,
        })
        for (const transition of mapped.value.transitions) {
          cheque = cheque.transitionTo(transition.to, {
            occurredAt: transition.occurredAt,
            reason: transition.reason,
          })
        }

        const state = await this.saveCounted(unitOfWork.cheques, cheque, counts.cheques)
        chequeStates.set(cheque.id, state)

        const reserved = reservedByBookId.get(mappedAccount.chequeBook.id)
        if (reserved !== undefined && !reserved.includes(input.chequeNumber)) {
          reserved.push(input.chequeNumber)
        }
      }

      // ---- Books: one manual migration book per mapped account, owning exactly the
      // numbers its migrated cheques consumed. Merge with existing reservations when
      // re-running (union), preserving the original book's createdAt.
      for (const mappedAccount of mappedByLegacyId.values()) {
        const bookId = mappedAccount.chequeBook.id
        const existing = await unitOfWork.chequeBooks.findById(bookId)

        const freshReservations = reservedByBookId.get(bookId) ?? []
        const mergedReservations =
          existing === null
            ? freshReservations
            : [...existing.reservedNumbers, ...freshReservations.filter((n) => !existing.hasReserved(n))]

        const duplicatesDropped = countDuplicates(freshReservations)
        if (duplicatesDropped > 0) {
          warnings.push(
            `legacy data contains repeated cheque numbers within book "${bookId}"; ` +
              `the reservation records each number once, the cheques themselves are preserved`
          )
        }

        const book = ChequeBook.create({
          id: bookId,
          bankAccountId: mappedAccount.bankAccount.id,
          label: mappedAccount.chequeBook.label,
          stockReference: null,
          sequence: { sequenceMode: 'manual' },
          status: 'active',
          reservedNumbers: mergedReservations,
          templateId: null,
          receivedAt: null,
          notes: null,
          createdAt: existing?.createdAt ?? mappedAccount.chequeBook.createdAt,
          updatedAt: mappedAccount.chequeBook.updatedAt,
        })

        await this.saveCounted(unitOfWork.chequeBooks, book, counts.chequeBooks)
      }

      await unitOfWork.commit()

      return {
        report: {
          legacy: { bankAccounts: legacyAccounts.length, checks: legacyChecks.length },
          banks: counts.banks,
          bankAccounts: counts.bankAccounts,
          chequeBooks: counts.chequeBooks,
          cheques: counts.cheques,
          failures,
          warnings,
        },
        chequeStates,
      }
    } catch (error) {
      await unitOfWork.rollback().catch(() => undefined)
      throw error
    }
  }

  /**
   * Save an entity and classify the outcome. `unchanged` means the incoming record is
   * byte-identical to the stored one — the definition of an idempotent replay.
   */
  private async saveCounted<T extends { id: string; toData(): unknown }>(
    repository: {
      save(entity: T): Promise<{ replaced: boolean }>
      findById(id: string): Promise<T | null>
    },
    entity: T,
    counts: MutableEntityMigrationCounts
  ): Promise<'created' | 'replaced' | 'unchanged'> {
    const existing = await repository.findById(entity.id)
    await repository.save(entity)

    if (existing === null) {
      counts.created += 1
      return 'created'
    }
    if (deepEqualJson(existing.toData(), entity.toData())) {
      counts.unchanged += 1
      return 'unchanged'
    }
    counts.replaced += 1
    return 'replaced'
  }
}

function countDuplicates(values: readonly string[]): number {
  return values.length - new Set(values).size
}

// ---------------------------------------------------------------------------
// Application wiring (lazy singleton)
// ---------------------------------------------------------------------------

export interface AppChequeDomainOptions {
  readonly core?: ChequeCore
  readonly legacySource?: LegacyDataSource
  readonly recordStore?: RecordStore
}

/**
 * Compose the application's boundary: ChequeCore over ChequePersistence over the
 * SecureStorageRecordStore adapter, reading legacy collections through the same
 * secure-storage service the app already uses.
 */
export function createAppChequeDomain(options: AppChequeDomainOptions = {}): ChequeDomainService {
  const recordStore = options.recordStore ?? new SecureStorageRecordStore()
  const core =
    options.core ??
    new ChequeCore({
      unitOfWorkFactory: new ChequePersistence({ store: recordStore }),
    })
  return new ChequeDomainService({
    core,
    legacySource: options.legacySource ?? createSecureStorageLegacySource(),
    recordStore,
  })
}

let applicationInstance: ChequeDomainService | null = null

/** Lazily created app-level boundary. No import-time side effects. */
export function getChequeDomain(): ChequeDomainService {
  if (applicationInstance === null) {
    applicationInstance = createAppChequeDomain()
  }
  return applicationInstance
}

/** Test hook: drop the shared instance so each test composes its own. */
export function resetChequeDomainForTests(): void {
  applicationInstance = null
}
