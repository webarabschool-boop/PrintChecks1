import { describe, expect, it } from 'vitest'
import { ChequePersistence, CorruptRecordError } from '../persistence/ChequePersistence'
import { InMemoryRecordStore, RECORD_STORE_CAPABILITIES } from '../persistence/RecordStore'
import {
  LocalStorageRecordStore,
  LocalStorageUnavailableError,
  type WebStorageLike,
} from '../persistence/LocalStorageRecordStore'
import { CryptoIdGenerator } from '../ids/CryptoIdGenerator'
import { Bank } from '../../domain/entities/Bank'
import { BankAccount } from '../../domain/entities/BankAccount'
import { ChequeBook } from '../../domain/entities/ChequeBook'
import { Cheque } from '../../domain/entities/Cheque'
import { Money } from '../../domain/value-objects/Money'

const T0 = '2026-01-15T10:00:00.000Z'

const bank = Bank.create({ id: 'bnk_1', code: 'NBE', name: 'National Bank of Egypt', createdAt: T0 })
const account = BankAccount.create({
  id: 'acc_1',
  bankId: 'bnk_1',
  holderName: 'Acme',
  accountNumber: '0012345',
  currency: 'EGP',
  createdAt: T0,
})
const book = ChequeBook.create({
  id: 'cbk_1',
  bankAccountId: 'acc_1',
  label: 'Book 1',
  sequence: { startSequence: 4567, endSequence: 4570 },
  createdAt: T0,
})
const cheque = Cheque.create({
  id: 'chq_1',
  chequeBookId: 'cbk_1',
  bankAccountId: 'acc_1',
  chequeNumber: 'A0001',
  amount: Money.fromDecimalString('1234.56', 'EGP'),
  payeeName: 'Supplier',
  createdAt: T0,
})

/** Minimal in-test stand-in for window.localStorage. */
class FakeWebStorage implements WebStorageLike {
  private readonly map = new Map<string, string>()
  get length(): number {
    return this.map.size
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  /** Test hook. */
  rawKeys(): string[] {
    return [...this.map.keys()]
  }
}

describe('ChequePersistence', () => {
  it('stores ONE KEY PER RECORD, never a whole-collection blob', async () => {
    const store = new InMemoryRecordStore()
    const persistence = new ChequePersistence({ store })

    const uow = await persistence.begin()
    await uow.banks.save(bank)
    await uow.bankAccounts.save(account)
    await uow.chequeBooks.save(book)
    await uow.cheques.save(cheque)
    await uow.commit()

    const keys = (await store.keys()).sort()
    expect(keys).toEqual([
      'printchecks:cheque:v1:bank:bnk_1',
      'printchecks:cheque:v1:bankAccount:acc_1',
      'printchecks:cheque:v1:cheque:chq_1',
      'printchecks:cheque:v1:chequeBook:cbk_1',
    ])

    // No aggregate collection key of the kind the legacy services wrote.
    expect(keys.some((k) => k.endsWith(':cheques'))).toBe(false)
    expect(keys.some((k) => k.endsWith(':checks'))).toBe(false)
  })

  it('honours a custom namespace', async () => {
    const store = new InMemoryRecordStore()
    const persistence = new ChequePersistence({ store, namespace: 'acme:v2' })
    const uow = await persistence.begin()
    await uow.banks.save(bank)
    await uow.commit()
    expect(await store.keys()).toEqual(['acme:v2:bank:bnk_1'])
  })

  it('does not collide with the legacy printchecks: collection keys', async () => {
    const store = new InMemoryRecordStore()
    // Simulated legacy data written by the old services.
    await store.set('printchecks:checks', [{ id: 'legacy' }])
    await store.set('printchecks:bankAccounts', [{ id: 'legacy' }])

    const persistence = new ChequePersistence({ store })
    await persistence.hydrate()

    // Legacy blobs are ignored, not parsed and not corrupted.
    expect(persistence.counts()).toEqual({ bank: 0, bankAccount: 0, chequeBook: 0, cheque: 0 })
    expect(await store.get('printchecks:checks')).toEqual([{ id: 'legacy' }])
  })

  it('rehydrates every record from the store', async () => {
    const store = new InMemoryRecordStore()
    const first = new ChequePersistence({ store })
    const uow = await first.begin()
    await uow.banks.save(bank)
    await uow.bankAccounts.save(account)
    await uow.chequeBooks.save(book)
    await uow.cheques.save(cheque)
    await uow.commit()

    // A brand-new instance over the same store must see everything.
    const second = new ChequePersistence({ store })
    const reloaded = await second.begin()

    expect((await reloaded.banks.findById('bnk_1'))?.name).toBe('National Bank of Egypt')
    expect((await reloaded.bankAccounts.findById('acc_1'))?.accountNumber).toBe('0012345')

    const reloadedBook = await reloaded.chequeBooks.findById('cbk_1')
    expect(reloadedBook?.sequence.startSequence).toBe(4567)
    expect(reloadedBook?.sequence.endSequence).toBe(4570)

    const reloadedCheque = await reloaded.cheques.findById('chq_1')
    // The cheque number survives as an exact string, leading zeros and prefix intact.
    expect(reloadedCheque?.chequeNumberValue).toBe('A0001')
    expect(reloadedCheque?.amount.toDecimalString()).toBe('1234.56')
    await reloaded.rollback()
  })

  it('preserves leading zeros in the account number across a reload', async () => {
    const store = new InMemoryRecordStore()
    const persistence = new ChequePersistence({ store })
    const uow = await persistence.begin()
    await uow.bankAccounts.save(account)
    await uow.commit()

    const second = new ChequePersistence({ store })
    const reloaded = await second.begin()
    expect((await reloaded.bankAccounts.findById('acc_1'))?.accountNumber).toBe('0012345')
    expect(await reloaded.bankAccounts.findByAccountNumber('bnk_1', '0012345')).not.toBeNull()
    // The numerically-equal but textually-different form is a different account.
    expect(await reloaded.bankAccounts.findByAccountNumber('bnk_1', '12345')).toBeNull()
    await reloaded.rollback()
  })

  describe('rollback', () => {
    it('discards every write in the unit of work', async () => {
      const store = new InMemoryRecordStore()
      const persistence = new ChequePersistence({ store })

      const uow = await persistence.begin()
      await uow.banks.save(bank)
      await uow.cheques.save(cheque)
      // Visible inside the unit of work...
      expect(await uow.banks.findById('bnk_1')).not.toBeNull()
      await uow.rollback()

      // ...and gone afterwards, in both the store and a fresh view.
      expect(await store.keys()).toEqual([])
      const fresh = await persistence.begin()
      expect(await fresh.banks.findById('bnk_1')).toBeNull()
      expect(await fresh.cheques.count()).toBe(0)
      await fresh.rollback()
    })

    it('leaves committed data untouched when a later unit of work rolls back', async () => {
      const store = new InMemoryRecordStore()
      const persistence = new ChequePersistence({ store })

      const first = await persistence.begin()
      await first.banks.save(bank)
      await first.commit()

      const second = await persistence.begin()
      await second.banks.save(bank.withChanges({ name: 'Renamed' }, T0))
      await second.rollback()

      const check = await persistence.begin()
      expect((await check.banks.findById('bnk_1'))?.name).toBe('National Bank of Egypt')
      await check.rollback()
    })

    it('isolates two concurrent units of work', async () => {
      const store = new InMemoryRecordStore()
      const persistence = new ChequePersistence({ store })

      const seed = await persistence.begin()
      await seed.banks.save(bank)
      await seed.commit()

      const a = await persistence.begin()
      const b = await persistence.begin()

      await a.banks.save(bank.withChanges({ name: 'From A' }, T0))
      // B still sees the committed state, not A's uncommitted write.
      expect((await b.banks.findById('bnk_1'))?.name).toBe('National Bank of Egypt')

      await a.commit()
      expect((await b.banks.findById('bnk_1'))?.name).toBe('National Bank of Egypt')
      await b.rollback()

      const check = await persistence.begin()
      expect((await check.banks.findById('bnk_1'))?.name).toBe('From A')
      await check.rollback()
    })

    it('refuses to use a unit of work after it is settled', async () => {
      const persistence = new ChequePersistence()
      const uow = await persistence.begin()
      await uow.commit()
      await expect(uow.banks.save(bank)).rejects.toThrow(/already been committed or rolled back/)
    })

    it('is a no-op to roll back twice', async () => {
      const persistence = new ChequePersistence()
      const uow = await persistence.begin()
      await uow.rollback()
      await expect(uow.rollback()).resolves.toBeUndefined()
    })
  })

  describe('deletes', () => {
    it('removes the record from the store on commit', async () => {
      const store = new InMemoryRecordStore()
      const persistence = new ChequePersistence({ store })

      const seed = await persistence.begin()
      await seed.banks.save(bank)
      await seed.commit()
      expect(await store.keys()).toHaveLength(1)

      const uow = await persistence.begin()
      expect(await uow.banks.delete('bnk_1')).toBe(true)
      await uow.commit()

      expect(await store.keys()).toEqual([])
      const check = await persistence.begin()
      expect(await check.banks.findById('bnk_1')).toBeNull()
      await check.rollback()
    })

    it('reports false when deleting something that does not exist', async () => {
      const persistence = new ChequePersistence()
      const uow = await persistence.begin()
      expect(await uow.banks.delete('nope')).toBe(false)
      await uow.rollback()
    })
  })

  describe('corrupt data is reported, not silently dropped', () => {
    it('throws CorruptRecordError for an unreadable record', async () => {
      const store = new InMemoryRecordStore()
      await store.set('printchecks:cheque:v1:bank:bnk_bad', { id: 'bnk_bad' }) // no code/name

      const persistence = new ChequePersistence({ store })
      await expect(persistence.hydrate()).rejects.toThrow(CorruptRecordError)
      await expect(persistence.hydrate()).rejects.toThrow(/could not be read/)
    })

    it('ignores keys outside the namespace', async () => {
      const store = new InMemoryRecordStore()
      await store.set('other:bank:bnk_1', 'not ours')
      await store.set('printchecks:cheque:v1:unknownCollection:x', {})
      await store.set('printchecks:cheque:v1', 'malformed')

      const persistence = new ChequePersistence({ store })
      await expect(persistence.hydrate()).resolves.toBeUndefined()
      expect(persistence.counts()).toEqual({ bank: 0, bankAccount: 0, chequeBook: 0, cheque: 0 })
    })
  })

  describe('capabilities and diagnostics', () => {
    it('reports best-effort by default and explains why', () => {
      const persistence = new ChequePersistence()
      expect(persistence.capabilities.guarantee).toBe('best-effort')
      expect(persistence.capabilities.limitation).toMatch(/no multi-key transaction/i)
      expect(RECORD_STORE_CAPABILITIES.guarantee).toBe('best-effort')
    })

    it('lets a transactional backend declare atomic', () => {
      const persistence = new ChequePersistence({ capabilities: { guarantee: 'atomic' } })
      expect(persistence.capabilities.guarantee).toBe('atomic')
    })

    it('records the last commit time', async () => {
      const persistence = new ChequePersistence()
      expect(persistence.diagnostics().lastCommitAt).toBeNull()

      const uow = await persistence.begin()
      await uow.banks.save(bank)
      await uow.commit()

      expect(persistence.diagnostics().lastCommitAt).not.toBeNull()
      expect(persistence.diagnostics().adapterName).toBe('ChequePersistence')
    })
  })

  describe('repository queries', () => {
    async function seeded() {
      const persistence = new ChequePersistence()
      const uow = await persistence.begin()
      await uow.banks.save(bank)
      await uow.bankAccounts.save(account)
      await uow.chequeBooks.save(book)
      await uow.cheques.save(cheque)
      await uow.commit()
      return persistence
    }

    it('finds cheques by book and exact number string', async () => {
      const persistence = await seeded()
      const uow = await persistence.begin()
      expect(await uow.cheques.findByChequeBookAndNumber('cbk_1', 'A0001')).not.toBeNull()
      expect(await uow.cheques.findByChequeBookAndNumber('cbk_1', 'a0001')).toBeNull()
      expect(await uow.cheques.findByChequeBookAndNumber('cbk_2', 'A0001')).toBeNull()
      await uow.rollback()
    })

    it('scopes hasChequeNumber to a single book', async () => {
      const persistence = await seeded()
      const otherBook = ChequeBook.create({
        id: 'cbk_2',
        bankAccountId: 'acc_1',
        label: 'Book 2',
        sequence: { sequenceMode: 'manual' },
        createdAt: T0,
      })
      const uow = await persistence.begin()
      await uow.chequeBooks.save(otherBook)
      await uow.commit()

      const check = await persistence.begin()
      // Present in cbk_1 via the cheque itself...
      expect(await check.chequeBooks.hasChequeNumber('cbk_1', 'A0001')).toBe(true)
      // ...and absent from cbk_2, so the same number is free there.
      expect(await check.chequeBooks.hasChequeNumber('cbk_2', 'A0001')).toBe(false)
      await check.rollback()
    })

    it('queries cheques by payee substring, status and number', async () => {
      const persistence = await seeded()
      const uow = await persistence.begin()

      expect(await uow.cheques.query({ payeeNameContains: 'supp' })).toHaveLength(1)
      expect(await uow.cheques.query({ payeeNameContains: 'nope' })).toHaveLength(0)
      expect(await uow.cheques.query({ chequeNumber: 'A0001' })).toHaveLength(1)
      expect(await uow.cheques.query({ chequeNumber: '1' })).toHaveLength(0)
      expect(await uow.cheques.query({ status: 'draft' })).toHaveLength(1)
      expect(await uow.cheques.query({ status: 'cleared' })).toHaveLength(0)
      expect(await uow.cheques.query({ direction: 'outgoing' })).toHaveLength(1)
      expect(await uow.cheques.query({ bankAccountId: 'acc_1' })).toHaveLength(1)
      expect(await uow.cheques.query({ dateFrom: '2026-01-01', dateTo: '2026-12-31' })).toHaveLength(1)
      expect(await uow.cheques.query({ dateFrom: '2027-01-01' })).toHaveLength(0)
      await uow.rollback()
    })

    it('lists issuable books and accounts per bank', async () => {
      const persistence = await seeded()
      const uow = await persistence.begin()
      expect(await uow.chequeBooks.findIssuable()).toHaveLength(1)
      expect(await uow.chequeBooks.findByBankAccountId('acc_1')).toHaveLength(1)
      expect(await uow.bankAccounts.findByBankId('bnk_1')).toHaveLength(1)
      expect(await uow.banks.findActive()).toHaveLength(1)
      expect(await uow.banks.findByCode('NBE')).not.toBeNull()
      await uow.rollback()
    })
  })
})

describe('LocalStorageRecordStore', () => {
  it('stores each record as its own JSON value under a prefix', async () => {
    const storage = new FakeWebStorage()
    const store = new LocalStorageRecordStore({ storage, keyPrefix: 'pc:' })

    await store.set('printchecks:cheque:v1:bank:bnk_1', bank.toData())
    expect(storage.rawKeys()).toEqual(['pc:printchecks:cheque:v1:bank:bnk_1'])

    const loaded = await store.get<Record<string, unknown>>('printchecks:cheque:v1:bank:bnk_1')
    expect(loaded).toEqual(bank.toData())
    expect(await store.keys()).toEqual(['printchecks:cheque:v1:bank:bnk_1'])
  })

  it('returns null for a missing key', async () => {
    const store = new LocalStorageRecordStore({ storage: new FakeWebStorage() })
    expect(await store.get('nope')).toBeNull()
  })

  it('removes records', async () => {
    const storage = new FakeWebStorage()
    const store = new LocalStorageRecordStore({ storage })
    await store.set('a', { v: 1 })
    await store.remove('a')
    expect(await store.get('a')).toBeNull()
    expect(storage.rawKeys()).toEqual([])
  })

  it('hides keys belonging to another prefix', async () => {
    const storage = new FakeWebStorage()
    storage.setItem('other:x', '1')
    const store = new LocalStorageRecordStore({ storage, keyPrefix: 'mine:' })
    expect(await store.keys()).toEqual([])
  })

  it('throws when no usable localStorage exists', () => {
    // Node has no globalThis.localStorage, so the default lookup must fail loudly rather
    // than silently pretending to persist.
    expect(() => new LocalStorageRecordStore()).toThrow(LocalStorageUnavailableError)
    expect(LocalStorageRecordStore.isAvailable()).toBe(false)
  })

  it('rejects an object that only looks like localStorage', () => {
    expect(() => new LocalStorageRecordStore({ storage: {} as WebStorageLike })).toThrow(
      LocalStorageUnavailableError
    )
  })
})

describe('CryptoIdGenerator', () => {
  it('produces prefixed RFC 4122 v4 identifiers', () => {
    const generator = new CryptoIdGenerator()
    const id = generator.next('cheque')

    expect(id).toMatch(/^chq_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('uses a distinct prefix per entity kind', () => {
    const generator = new CryptoIdGenerator()
    const prefixes = (['bank', 'bankAccount', 'chequeBook', 'cheque', 'transaction'] as const).map(
      (kind) => generator.next(kind).split('_')[0]
    )
    expect(new Set(prefixes).size).toBe(5)
  })

  it('never repeats across a large batch', () => {
    const generator = new CryptoIdGenerator()
    const ids = new Set<string>()
    for (let i = 0; i < 5000; i += 1) ids.add(generator.next('cheque'))
    expect(ids.size).toBe(5000)
  })

  it('generates distinct ids within the same millisecond', () => {
    // The legacy Date.now()+Math.random() scheme collided here.
    const generator = new CryptoIdGenerator()
    const start = Date.now()
    const ids = new Set<string>()
    while (Date.now() === start) {
      ids.add(generator.next('cheque'))
      if (ids.size > 200) break
    }
    expect(ids.size).toBeGreaterThan(1)
  })

  it('rejects an unknown kind', () => {
    const generator = new CryptoIdGenerator()
    expect(() => generator.next('vendor' as never)).toThrow(/Unknown identifier kind/)
  })

  it('reports platform support', () => {
    expect(typeof CryptoIdGenerator.isSupported()).toBe('boolean')
    expect(CryptoIdGenerator.isSupported()).toBe(true)
  })

  it('produces ids unrelated to cheque numbers', () => {
    const generator = new CryptoIdGenerator()
    const id = generator.next('cheque')
    // The internal id is a surrogate; it is never derived from or usable as a cheque number.
    expect(id).not.toBe(cheque.chequeNumberValue)
    expect(id.length).toBeGreaterThan(20)
  })
})
