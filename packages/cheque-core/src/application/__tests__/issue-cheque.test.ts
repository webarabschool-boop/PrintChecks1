import { describe, expect, it } from 'vitest'
import { ChequeCore } from '../ChequeCore'
import { IssueChequeUseCase, TRANSACTIONALITY } from '../IssueChequeUseCase'
import { Cheque } from '../../domain/entities/Cheque'
import { Money } from '../../domain/value-objects/Money'
import { FixedClock } from '../../ports/Clock'
import type { IdGenerator } from '../../ports/IdGenerator'
import type { ChequeBookSequenceInput } from '../../domain/sequence/ChequeBookSequence'
import { ChequePersistence } from '../../infrastructure/persistence/ChequePersistence'
import { InMemoryRecordStore, type RecordStore } from '../../infrastructure/persistence/RecordStore'
import {
  AutomaticNumberNotPermittedError,
  ChequeBookExhaustedError,
  ChequeBookNotActiveError,
  DuplicateChequeNumberError,
  EntityNotFoundError,
  InactiveEntityError,
  InvalidChequeNumberError,
  ManualNumberRequiredError,
} from '../../domain/errors'

const T0 = '2026-01-15T10:00:00.000Z'

/** Deterministic id generator so tests can assert on identifiers. */
class SequentialIdGenerator implements IdGenerator {
  private readonly counters = new Map<string, number>()
  next(kind: string): string {
    const n = (this.counters.get(kind) ?? 0) + 1
    this.counters.set(kind, n)
    return `${kind}_${n}`
  }
}

/**
 * Wraps a RecordStore and fails the Nth write AFTER being armed, to exercise the
 * partial-flush path without reaching into any private state.
 *
 * Arming matters: the fixture itself performs writes (bank, account, book), so an
 * always-live counter would fail during setup rather than during issuance.
 */
class FailingRecordStore implements RecordStore {
  private writes = 0
  private armed = false

  constructor(
    private readonly inner: RecordStore,
    private readonly failOnWrite: number
  ) {}

  /** Start counting writes from here. */
  arm(): void {
    this.armed = true
    this.writes = 0
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    return this.inner.get<T>(key)
  }
  async set<T = unknown>(key: string, value: T): Promise<void> {
    if (this.armed) {
      this.writes += 1
      if (this.writes === this.failOnWrite) {
        throw new Error(`simulated storage failure on write #${this.failOnWrite} (${key})`)
      }
    }
    return this.inner.set(key, value)
  }
  async remove(key: string): Promise<void> {
    return this.inner.remove(key)
  }
  async keys(): Promise<string[]> {
    return this.inner.keys()
  }
}

type SequenceInput = ChequeBookSequenceInput

interface FixtureOptions {
  readonly sequence?: SequenceInput
  readonly store?: RecordStore
}

async function fixture(options: FixtureOptions = {}) {
  const clock = new FixedClock(T0)
  const store = options.store ?? new InMemoryRecordStore()
  const persistence = new ChequePersistence({ store })
  const core = new ChequeCore({
    unitOfWorkFactory: persistence,
    clock,
    idGenerator: new SequentialIdGenerator(),
  })

  const bank = await core.createBank({ code: 'NBE', name: 'National Bank of Egypt' })
  const account = await core.createBankAccount({
    bankId: bank.id,
    holderName: 'Acme Trading',
    accountNumber: '0012345',
    currency: 'EGP',
  })
  const book = await core.createChequeBook({
    bankAccountId: account.id,
    label: 'Book 1',
    sequence: options.sequence ?? {
      sequenceMode: 'numeric',
      startSequence: 4567,
      endSequence: 4576,
    },
  })

  return { core, clock, store, persistence, bank, account, book }
}

/** Read a book back from persistence, outside any returned object graph. */
async function reloadBook(core: ChequeCore, id: string) {
  return core.findChequeBook(id)
}

/**
 * Issuance coverage — required test list items 7, 12, 13 and 14.
 */
describe('IssueCheque', () => {
  describe('atomic issuance happy path', () => {
    it('obtains the number, creates the cheque, advances the book and persists all of it', async () => {
      const { core, book, bank } = await fixture()

      const result = await core.issueCheque({
        chequeBookId: book.id,
        payeeName: 'Supplier Co',
        amount: Money.fromDecimalString('1250.75', 'EGP'),
      })

      // 1. number obtained from the book that owns it
      expect(result.chequeNumber).toBe('4567')
      expect(result.cheque.chequeNumberValue).toBe('4567')

      // 2. cheque created with the right relationships
      expect(result.cheque.chequeBookId).toBe(book.id)
      expect(result.cheque.bankAccountId).toBe(result.bankAccountId)
      expect(result.bankId).toBe(bank.id)
      expect(result.cheque.payeeName).toBe('Supplier Co')
      expect(result.cheque.amount.toDecimalString()).toBe('1250.75')
      expect(result.cheque.direction).toBe('outgoing')
      expect(result.cheque.status).toBe('issued')

      // 3. book advanced
      expect(result.chequeBook.sequence.currentSequence).toBe(4568)
      expect(result.chequeBook.remaining).toBe(9)

      // 4. persisted — verified by reloading, not by trusting the returned object
      const reloaded = await reloadBook(core, book.id)
      expect(reloaded?.sequence.currentSequence).toBe(4568)
      const reloadedCheque = await core.findCheque(result.cheque.id)
      expect(reloadedCheque?.chequeNumberValue).toBe('4567')
    })

    it('advances the sequence by exactly one per issuance (required case 12)', async () => {
      const { core, book } = await fixture()

      const issued: string[] = []
      for (let i = 0; i < 5; i += 1) {
        const result = await core.issueCheque({
          chequeBookId: book.id,
          payeeName: `Payee ${i}`,
          amount: Money.fromDecimalString('10.00', 'EGP'),
        })
        issued.push(result.chequeNumber)
      }

      expect(issued).toEqual(['4567', '4568', '4569', '4570', '4571'])

      const reloaded = await reloadBook(core, book.id)
      expect(reloaded?.sequence.currentSequence).toBe(4572)
      expect(reloaded?.remaining).toBe(5)
      expect(reloaded?.reservedNumbers).toEqual(issued)
    })

    it('advances an alphanumeric sequence with zero padding', async () => {
      const { core, book } = await fixture({
        sequence: {
          sequenceMode: 'alphanumeric',
          prefix: 'A',
          startSequence: 1,
          sequenceWidth: 4,
          endSequence: 3,
        },
      })

      const first = await core.issueCheque({
        chequeBookId: book.id,
        payeeName: 'X',
        amount: Money.fromDecimalString('1.00', 'EGP'),
      })
      const second = await core.issueCheque({
        chequeBookId: book.id,
        payeeName: 'Y',
        amount: Money.fromDecimalString('2.00', 'EGP'),
      })

      expect(first.chequeNumber).toBe('A0001')
      expect(second.chequeNumber).toBe('A0002')
    })

    it('uses the injected clock for chequeDate and createdAt', async () => {
      const { core, book } = await fixture()
      const result = await core.issueCheque({
        chequeBookId: book.id,
        payeeName: 'X',
        amount: Money.zero('EGP'),
      })
      expect(result.cheque.chequeDate).toBe(T0.slice(0, 10))
      expect(result.cheque.createdAt).toBe(T0)
    })

    it('honours an explicit chequeDate distinct from createdAt', async () => {
      const { core, book } = await fixture()
      const result = await core.issueCheque({
        chequeBookId: book.id,
        payeeName: 'X',
        amount: Money.zero('EGP'),
        chequeDate: '2026-03-01',
      })
      expect(result.cheque.chequeDate).toBe('2026-03-01')
      expect(result.cheque.createdAt).toBe(T0)
    })

    it('can create a draft instead of an issued cheque', async () => {
      const { core, book } = await fixture()
      const result = await core.issueCheque({
        chequeBookId: book.id,
        payeeName: 'X',
        amount: Money.zero('EGP'),
        initialStatus: 'draft',
      })
      expect(result.cheque.status).toBe('draft')
      // The number is still consumed: a draft reserves its leaf.
      expect(result.chequeBook.sequence.currentSequence).toBe(4568)
    })

    it('records the actor on the issued cheque', async () => {
      const { core, book } = await fixture()
      const result = await core.issueCheque({
        chequeBookId: book.id,
        payeeName: 'X',
        amount: Money.zero('EGP'),
        actorId: 'user_9',
      })
      expect(result.cheque.createdBy).toBe('user_9')
    })
  })

  describe('manual numbering mode (required case 7)', () => {
    it('accepts an operator-supplied number verbatim', async () => {
      const { core, book } = await fixture({ sequence: { sequenceMode: 'manual', prefix: 'A' } })

      const result = await core.issueCheque({
        chequeBookId: book.id,
        payeeName: 'X',
        amount: Money.fromDecimalString('5.00', 'EGP'),
        chequeNumber: 'A0001',
      })

      expect(result.chequeNumber).toBe('A0001')
      expect(result.cheque.chequeNumberValue).toBe('A0001')
    })

    it('reserves the manual number so it cannot be reused', async () => {
      const { core, book } = await fixture({ sequence: { sequenceMode: 'manual' } })

      await core.issueCheque({
        chequeBookId: book.id,
        payeeName: 'X',
        amount: Money.zero('EGP'),
        chequeNumber: '777',
      })

      await expect(
        core.issueCheque({
          chequeBookId: book.id,
          payeeName: 'Y',
          amount: Money.zero('EGP'),
          chequeNumber: '777',
        })
      ).rejects.toThrow(DuplicateChequeNumberError)
    })

    it('requires a number on a manual book', async () => {
      const { core, book } = await fixture({ sequence: { sequenceMode: 'manual' } })

      await expect(
        core.issueCheque({
          chequeBookId: book.id,
          payeeName: 'X',
          amount: Money.zero('EGP'),
        })
      ).rejects.toThrow(ManualNumberRequiredError)
    })

    it('rejects a manual number that ignores the configured prefix', async () => {
      const { core, book } = await fixture({ sequence: { sequenceMode: 'manual', prefix: 'A' } })

      await expect(
        core.issueCheque({
          chequeBookId: book.id,
          payeeName: 'X',
          amount: Money.zero('EGP'),
          chequeNumber: 'B0001',
        })
      ).rejects.toThrow(/does not start with the book's prefix/)
    })

    it('rejects an unusable manual number string', async () => {
      const { core, book } = await fixture({ sequence: { sequenceMode: 'manual' } })

      await expect(
        core.issueCheque({
          chequeBookId: book.id,
          payeeName: 'X',
          amount: Money.zero('EGP'),
          chequeNumber: '  77  ',
        })
      ).rejects.toThrow(InvalidChequeNumberError)
    })

    it('does not advance any cursor on a manual book', async () => {
      const { core, book } = await fixture({ sequence: { sequenceMode: 'manual' } })

      const result = await core.issueCheque({
        chequeBookId: book.id,
        payeeName: 'X',
        amount: Money.zero('EGP'),
        chequeNumber: '1',
      })

      expect(result.chequeBook.sequence.currentSequence).toBe(book.sequence.currentSequence)
      expect(result.chequeBook.remaining).toBeNull()
    })
  })

  describe('forbids a caller-supplied number on an automatic book', () => {
    it('throws AutomaticNumberNotPermittedError', async () => {
      const { core, book } = await fixture()

      await expect(
        core.issueCheque({
          chequeBookId: book.id,
          payeeName: 'X',
          amount: Money.zero('EGP'),
          chequeNumber: '9999',
        })
      ).rejects.toThrow(AutomaticNumberNotPermittedError)
    })

    it('consumes nothing when the number is rejected', async () => {
      const { core, book } = await fixture()

      await expect(
        core.issueCheque({
          chequeBookId: book.id,
          payeeName: 'X',
          amount: Money.zero('EGP'),
          chequeNumber: '9999',
        })
      ).rejects.toThrow(AutomaticNumberNotPermittedError)

      const reloaded = await reloadBook(core, book.id)
      expect(reloaded?.sequence.currentSequence).toBe(4567)
      expect(reloaded?.reservedNumbers).toEqual([])
    })
  })

  describe('context validation before any number is consumed', () => {
    it('rejects an unknown cheque book', async () => {
      const { core } = await fixture()
      await expect(
        core.issueCheque({
          chequeBookId: 'cbk_missing',
          payeeName: 'X',
          amount: Money.zero('EGP'),
        })
      ).rejects.toThrow(EntityNotFoundError)
    })

    it('rejects an exhausted book', async () => {
      const { core, book } = await fixture({ sequence: { startSequence: 1, endSequence: 1 } })

      await core.issueCheque({
        chequeBookId: book.id,
        payeeName: 'X',
        amount: Money.zero('EGP'),
      })

      await expect(
        core.issueCheque({
          chequeBookId: book.id,
          payeeName: 'Y',
          amount: Money.zero('EGP'),
        })
      ).rejects.toThrow(ChequeBookExhaustedError)
    })

    it('rejects a retired book', async () => {
      const { core, book } = await fixture()
      const uow = await core.unitOfWorkFactory.begin()
      const retired = (await uow.chequeBooks.findById(book.id))!.retire(T0)
      await uow.chequeBooks.save(retired)
      await uow.commit()

      await expect(
        core.issueCheque({
          chequeBookId: book.id,
          payeeName: 'X',
          amount: Money.zero('EGP'),
        })
      ).rejects.toThrow(ChequeBookNotActiveError)
    })

    it('rejects an inactive bank account', async () => {
      const { core, book, account } = await fixture()
      const uow = await core.unitOfWorkFactory.begin()
      await uow.bankAccounts.save(account.withChanges({ isActive: false }, T0))
      await uow.commit()

      await expect(
        core.issueCheque({
          chequeBookId: book.id,
          payeeName: 'X',
          amount: Money.zero('EGP'),
        })
      ).rejects.toThrow(InactiveEntityError)
    })

    it('rejects an inactive bank', async () => {
      const { core, book, bank } = await fixture()
      const uow = await core.unitOfWorkFactory.begin()
      await uow.banks.save(bank.deactivate(T0))
      await uow.commit()

      await expect(
        core.issueCheque({
          chequeBookId: book.id,
          payeeName: 'X',
          amount: Money.zero('EGP'),
        })
      ).rejects.toThrow(InactiveEntityError)
    })

    it('rejects a missing payee', async () => {
      const { core, book } = await fixture()

      await expect(
        core.issueCheque({
          chequeBookId: book.id,
          payeeName: '   ',
          amount: Money.zero('EGP'),
        })
      ).rejects.toThrow(/payeeName/)
    })

    it('leaves the book untouched when validation fails', async () => {
      const { core, book } = await fixture()

      await expect(
        core.issueCheque({
          chequeBookId: book.id,
          payeeName: '   ',
          amount: Money.zero('EGP'),
        })
      ).rejects.toThrow()

      const reloaded = await reloadBook(core, book.id)
      expect(reloaded?.sequence.currentSequence).toBe(4567)
      expect(reloaded?.reservedNumbers).toEqual([])

      const uow = await core.unitOfWorkFactory.begin()
      expect(await uow.cheques.count()).toBe(0)
      await uow.rollback()
    })
  })

  describe('end of book', () => {
    it('issues the last number and then marks the book exhausted', async () => {
      const { core, book } = await fixture({ sequence: { startSequence: 1, endSequence: 3 } })

      const numbers: string[] = []
      for (let i = 0; i < 3; i += 1) {
        const r = await core.issueCheque({
          chequeBookId: book.id,
          payeeName: `P${i}`,
          amount: Money.zero('EGP'),
        })
        numbers.push(r.chequeNumber)
      }

      expect(numbers).toEqual(['1', '2', '3'])

      const reloaded = await reloadBook(core, book.id)
      expect(reloaded?.status).toBe('exhausted')
      expect(reloaded?.remaining).toBe(0)
      expect(reloaded?.isIssuable).toBe(false)

      await expect(
        core.issueCheque({
          chequeBookId: book.id,
          payeeName: 'P4',
          amount: Money.zero('EGP'),
        })
      ).rejects.toThrow(ChequeBookExhaustedError)
    })

    it('never wraps back to the start sequence', async () => {
      const { core, book } = await fixture({ sequence: { startSequence: 1, endSequence: 2 } })

      await core.issueCheque({ chequeBookId: book.id, payeeName: 'A', amount: Money.zero('EGP') })
      await core.issueCheque({ chequeBookId: book.id, payeeName: 'B', amount: Money.zero('EGP') })

      const reloaded = await reloadBook(core, book.id)
      expect(reloaded?.sequence.currentSequence).toBe(3)

      await expect(
        core.issueCheque({ chequeBookId: book.id, payeeName: 'C', amount: Money.zero('EGP') })
      ).rejects.toThrow(ChequeBookExhaustedError)

      const after = await reloadBook(core, book.id)
      expect(after?.sequence.currentSequence).toBe(3)
      expect(after?.reservedNumbers).toEqual(['1', '2'])
    })
  })

  describe('failed issuance is never a silent success (required cases 13 and 14)', () => {
    it('propagates the error instead of resolving', async () => {
      const { core, book } = await fixture()

      await expect(
        core.issueCheque({ chequeBookId: book.id, payeeName: '', amount: Money.zero('EGP') })
      ).rejects.toThrow()
    })

    it('persists nothing when issuance fails', async () => {
      const { core, book } = await fixture()

      await expect(
        core.issueCheque({ chequeBookId: book.id, payeeName: '', amount: Money.zero('EGP') })
      ).rejects.toThrow()

      const uow = await core.unitOfWorkFactory.begin()
      expect(await uow.cheques.count()).toBe(0)
      const reloaded = await uow.chequeBooks.findById(book.id)
      expect(reloaded?.status).toBe('active')
      expect(reloaded?.sequence.currentSequence).toBe(4567)
      await uow.rollback()
    })

    it('does NOT consume the sequence number when creation fails (required case 14)', async () => {
      const { core, book } = await fixture()

      // The cheque entity is built AFTER the number is allocated, so an invalid payee
      // fails after allocation. The whole unit of work must roll back.
      await expect(
        core.issueCheque({ chequeBookId: book.id, payeeName: '', amount: Money.zero('EGP') })
      ).rejects.toThrow(/payeeName/)

      const reloaded = await reloadBook(core, book.id)
      expect(reloaded?.sequence.currentSequence).toBe(4567)
      expect(reloaded?.reservedNumbers).toEqual([])

      // The number remains available to the next, successful issuance.
      const next = await core.issueCheque({
        chequeBookId: book.id,
        payeeName: 'Valid Payee',
        amount: Money.zero('EGP'),
      })
      expect(next.chequeNumber).toBe('4567')
    })

    it('writes the book before the cheque, so a partial flush leaves a gap not a duplicate', async () => {
      const store = new InMemoryRecordStore()
      // Armed after setup. In COMMIT_ORDER the chequeBook is written before the cheque,
      // so write #1 is the advanced book and write #2 is the cheque.
      const failing = new FailingRecordStore(store, 2)
      const { core, book } = await fixture({ store: failing })
      failing.arm()

      await expect(
        core.issueCheque({ chequeBookId: book.id, payeeName: 'X', amount: Money.zero('EGP') })
      ).rejects.toThrow(/simulated storage failure/)

      const uow = await core.unitOfWorkFactory.begin()

      // The cheque was NOT persisted — the failure is loud, never a silent success.
      expect(await uow.cheques.count()).toBe(0)

      // The book DID advance. On a store with no transactions this is the safe partial
      // state: number 4567 is consumed but unused (a gap), and can never be re-issued.
      // The unsafe alternative — cheque persisted, book not advanced — would hand 4567
      // out a second time.
      const reloaded = await uow.chequeBooks.findById(book.id)
      expect(reloaded?.sequence.currentSequence).toBe(4568)
      await uow.rollback()

      // Prove the gap is not a duplicate: the next issuance yields a fresh number.
      const next = await core.issueCheque({
        chequeBookId: book.id,
        payeeName: 'X',
        amount: Money.zero('EGP'),
      })
      expect(next.chequeNumber).toBe('4568')
      expect(next.chequeNumber).not.toBe('4567')

      const finalUow = await core.unitOfWorkFactory.begin()
      const all = await finalUow.cheques.findAll()
      const numbers = all.map((c) => c.chequeNumberValue)
      expect(numbers).toEqual(['4568'])
      expect(new Set(numbers).size).toBe(numbers.length)
      await finalUow.rollback()
    })

    it('detects a duplicate already present in the repository but not in the book', async () => {
      const { core, book } = await fixture({ sequence: { sequenceMode: 'manual' } })

      // Seed a cheque directly, bypassing the book's reservation set, to simulate
      // imported or legacy data.
      const uow = await core.unitOfWorkFactory.begin()
      await uow.cheques.save(
        Cheque.create({
          id: 'chq_seeded',
          chequeBookId: book.id,
          bankAccountId: book.bankAccountId,
          chequeNumber: '555',
          amount: Money.zero('EGP'),
          payeeName: 'Legacy',
          createdAt: T0,
        })
      )
      await uow.commit()

      // The book itself does not know about it...
      expect(book.hasReserved('555')).toBe(false)
      // ...but the repository does, which is what the duplicate guard consults.
      const check = await core.unitOfWorkFactory.begin()
      expect(await check.chequeBooks.hasChequeNumber(book.id, '555')).toBe(true)
      await check.rollback()

      await expect(
        core.issueCheque({
          chequeBookId: book.id,
          payeeName: 'New',
          amount: Money.zero('EGP'),
          chequeNumber: '555',
        })
      ).rejects.toThrow(DuplicateChequeNumberError)
    })
  })

  describe('transactional guarantee is declared, not assumed', () => {
    it('reports best-effort for a plain record store', async () => {
      const { core } = await fixture()
      expect(core.transactionGuarantee).toBe('best-effort')
      expect(core.transactionGuaranteeDescription()).toMatch(/transaction/i)
      expect(core.diagnostics().capabilities.guarantee).toBe('best-effort')
    })

    it('exposes the guarantee on the use case before doing any work', async () => {
      const { core } = await fixture()
      const useCase = new IssueChequeUseCase({
        unitOfWorkFactory: core.unitOfWorkFactory,
        idGenerator: new SequentialIdGenerator(),
        clock: new FixedClock(T0),
      })
      expect(useCase.transactionGuarantee).toBe('best-effort')
    })

    it('reports the guarantee on each successful issuance', async () => {
      const { core, book } = await fixture()
      const result = await core.issueCheque({
        chequeBookId: book.id,
        payeeName: 'X',
        amount: Money.zero('EGP'),
      })
      expect(result.transactionGuarantee).toBe('best-effort')
    })

    it('documents the localStorage limitation', () => {
      expect(TRANSACTIONALITY.bestEffort).toMatch(/localStorage offers no transactions/)
      expect(TRANSACTIONALITY.bestEffort).toMatch(/never\s+re-issued/)
      expect(TRANSACTIONALITY.atomic).toMatch(/single transaction/)
    })
  })

  describe('numbering is scoped per book, with no global counter', () => {
    it('runs two books at the same bank through independent sequences', async () => {
      const { core, account } = await fixture()

      const bookA = await core.createChequeBook({
        bankAccountId: account.id,
        label: 'Book A',
        sequence: { sequenceMode: 'numeric', startSequence: 4567, endSequence: 4570 },
      })
      const bookB = await core.createChequeBook({
        bankAccountId: account.id,
        label: 'Book B',
        sequence: { sequenceMode: 'numeric', startSequence: 4567, endSequence: 4570 },
      })

      const a1 = await core.issueCheque({
        chequeBookId: bookA.id,
        payeeName: 'A1',
        amount: Money.zero('EGP'),
      })
      const b1 = await core.issueCheque({
        chequeBookId: bookB.id,
        payeeName: 'B1',
        amount: Money.zero('EGP'),
      })

      // Same number, different books: legal, and neither issuance blocks the other.
      expect(a1.chequeNumber).toBe('4567')
      expect(b1.chequeNumber).toBe('4567')

      const a2 = await core.issueCheque({
        chequeBookId: bookA.id,
        payeeName: 'A2',
        amount: Money.zero('EGP'),
      })
      const b2 = await core.issueCheque({
        chequeBookId: bookB.id,
        payeeName: 'B2',
        amount: Money.zero('EGP'),
      })
      expect(a2.chequeNumber).toBe('4568')
      expect(b2.chequeNumber).toBe('4568')

      // Each book tracks its own reservations independently.
      expect((await reloadBook(core, bookA.id))?.reservedNumbers).toEqual(['4567', '4568'])
      expect((await reloadBook(core, bookB.id))?.reservedNumbers).toEqual(['4567', '4568'])
    })

    it('rejects a duplicate within one book while allowing it in another', async () => {
      const { core, account } = await fixture()

      const bookA = await core.createChequeBook({
        bankAccountId: account.id,
        label: 'Manual A',
        sequence: { sequenceMode: 'manual' },
      })
      const bookB = await core.createChequeBook({
        bankAccountId: account.id,
        label: 'Manual B',
        sequence: { sequenceMode: 'manual' },
      })

      await core.issueCheque({
        chequeBookId: bookA.id,
        payeeName: 'X',
        amount: Money.zero('EGP'),
        chequeNumber: '0001',
      })

      // The same number in the other book is fine.
      const other = await core.issueCheque({
        chequeBookId: bookB.id,
        payeeName: 'Y',
        amount: Money.zero('EGP'),
        chequeNumber: '0001',
      })
      expect(other.chequeNumber).toBe('0001')

      // ...but not twice in the same book.
      await expect(
        core.issueCheque({
          chequeBookId: bookA.id,
          payeeName: 'Z',
          amount: Money.zero('EGP'),
          chequeNumber: '0001',
        })
      ).rejects.toThrow(DuplicateChequeNumberError)
    })

    it('keeps a cancelled cheque\'s number reserved so it is never reused', async () => {
      const { core, book } = await fixture({ sequence: { startSequence: 1, endSequence: 5 } })

      const issued = await core.issueCheque({
        chequeBookId: book.id,
        payeeName: 'Spoiled',
        amount: Money.zero('EGP'),
      })
      expect(issued.chequeNumber).toBe('1')

      const cancelled = await core.transitionCheque(issued.cheque.id, 'cancelled', {
        reason: 'spoiled leaf',
      })
      expect(cancelled.status).toBe('cancelled')

      // The next issuance skips past the cancelled number rather than reusing it.
      const next = await core.issueCheque({
        chequeBookId: book.id,
        payeeName: 'Replacement',
        amount: Money.zero('EGP'),
      })
      expect(next.chequeNumber).toBe('2')
      expect((await reloadBook(core, book.id))?.reservedNumbers).toEqual(['1', '2'])
    })
  })
})
