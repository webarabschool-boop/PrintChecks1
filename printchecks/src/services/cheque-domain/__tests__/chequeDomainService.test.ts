import { beforeEach, describe, expect, it } from 'vitest'
import {
  ChequeBookExhaustedError,
  ChequeCore,
  ChequePersistence,
  DuplicateChequeNumberError,
  EntityNotFoundError,
  FixedClock,
  InMemoryRecordStore,
  InvalidMoneyError,
  ManualNumberRequiredError,
} from '@printchecks/cheque-core'

import { ChequeDomainService } from '../ChequeDomainService'
import { createStaticLegacySource, createSecureStorageLegacySource } from '../legacySource'
import { SecureStorageRecordStore, DOMAIN_KEY_PREFIX } from '../persistence/SecureStorageRecordStore'
import { secureStorage } from '../../secureStorage'
import type { LegacyBankAccountShape, LegacyCheckShape } from '../legacyMapping'

// ---------------------------------------------------------------------------
// Fixtures and composition
// ---------------------------------------------------------------------------

const FIXED_NOW = '2026-09-17T12:00:00.000Z'

function composeBoundary(legacy: {
  bankAccounts?: LegacyBankAccountShape[]
  checks?: LegacyCheckShape[]
} = {}) {
  const recordStore = new InMemoryRecordStore()
  const core = new ChequeCore({
    unitOfWorkFactory: new ChequePersistence({ store: recordStore, namespace: 'test:cheque:v1' }),
    clock: new FixedClock(FIXED_NOW),
  })
  const service = new ChequeDomainService({
    core,
    legacySource: createStaticLegacySource({
      bankAccounts: legacy.bankAccounts ?? [],
      checks: legacy.checks ?? [],
    }),
    recordStore,
    namespace: 'test:cheque:v1',
  })
  return { service, recordStore }
}

const ACCOUNT_A: LegacyBankAccountShape = {
  id: 'legacy-acc-1',
  name: 'First National',
  accountHolderName: 'Jane Smith',
  accountNumber: '0012345',
  accountType: 'business',
  createdAt: '2026-01-05T08:00:00.000Z',
}

const CHECK_ALPHA: LegacyCheckShape = {
  id: 'legacy-check-1',
  checkNumber: 'A0099',
  amount: '1250.75',
  payTo: 'Acme Corp',
  bankName: 'First National',
  bankAccountNumber: '0012345',
  date: '9/17/2026',
  memo: 'invoice 44',
  createdAt: '2026-09-17T09:00:00.000Z',
  updatedAt: '2026-09-17T09:30:00.000Z',
}

async function makeBookSequence(
  service: ChequeDomainService,
  sequence: Parameters<ChequeDomainService['createChequeBook']>[0]['sequence']
) {
  const bank = await service.createBank({ code: 'TEST', name: 'Test Bank' })
  const account = await service.createBankAccount({
    bankId: bank.id,
    holderName: 'Holder',
    accountNumber: '000999',
    currency: 'XXX',
  })
  const book = await service.createChequeBook({
    bankAccountId: account.id,
    label: 'Series 1',
    sequence,
  })
  return { bank, account, book }
}

const issue = (service: ChequeDomainService, chequeBookId: string, payeeName = 'Payee') =>
  service.issueCheque({ chequeBookId, payeeName, amount: { decimal: '100.00', currency: 'XXX' } })

// ---------------------------------------------------------------------------
// Canonical chain: Bank → BankAccount → ChequeBook → Cheque
// ---------------------------------------------------------------------------

describe('canonical chain integration (Bank → BankAccount → ChequeBook → Cheque)', () => {
  it('creates and traverses the whole ownership chain', async () => {
    const { service } = composeBoundary()
    const { bank, account, book } = await makeBookSequence(service, { startSequence: 4567 })

    await expect(service.listBanks()).resolves.toHaveLength(1)
    const accounts = await service.listBankAccounts(bank.id)
    expect(accounts.map((a) => a.id)).toEqual([account.id])
    const books = await service.listChequeBooks(account.id)
    expect(books.map((b) => b.id)).toEqual([book.id])

    const issued = await issue(service, book.id)
    expect(issued.bankAccountId).toBe(account.id)
    expect(issued.bankId).toBe(bank.id)

    const cheques = await service.listCheques(book.id)
    expect(cheques.map((c) => c.id)).toEqual([issued.chequeId])
    expect(cheques[0]?.chequeBookId).toBe(book.id)
    expect(cheques[0]?.bankAccountId).toBe(account.id)
  })

  it('rejects an account under a non-existent bank instead of fabricating one', async () => {
    const { service } = composeBoundary()
    await expect(
      service.createBankAccount({
        bankId: 'bank:missing',
        holderName: 'Holder',
        accountNumber: '1',
        currency: 'XXX',
      })
    ).rejects.toBeInstanceOf(EntityNotFoundError)
  })
})

// ---------------------------------------------------------------------------
// Cheque numbers through the boundary — the non-negotiable rules
// ---------------------------------------------------------------------------

describe('cheque numbering through the application boundary', () => {
  it('4567 → 4568 (numeric mode, cursor advances by exactly one)', async () => {
    const { service } = composeBoundary()
    const { book } = await makeBookSequence(service, { sequenceMode: 'numeric', startSequence: 4567 })

    expect(await service.peekNextChequeNumber(book.id)).toBe('4567')
    expect((await issue(service, book.id)).chequeNumber).toBe('4567')
    expect((await issue(service, book.id)).chequeNumber).toBe('4568')
    expect((await issue(service, book.id)).chequeNumber).toBe('4569')
  })

  it('A4567 → A4568 (alphanumeric prefix preserved)', async () => {
    const { service } = composeBoundary()
    const { book } = await makeBookSequence(service, {
      sequenceMode: 'alphanumeric',
      prefix: 'A',
      startSequence: 4567,
    })
    expect((await issue(service, book.id)).chequeNumber).toBe('A4567')
    expect((await issue(service, book.id)).chequeNumber).toBe('A4568')
  })

  it('A0001 → A0002 → A0003 (zero padding; the third value is proven, not just the next)', async () => {
    const { service } = composeBoundary()
    const { book } = await makeBookSequence(service, {
      sequenceMode: 'alphanumeric',
      prefix: 'A',
      startSequence: 1,
      sequenceWidth: 4,
    })
    const first = await issue(service, book.id)
    const second = await issue(service, book.id)
    const third = await issue(service, book.id)
    expect([first.chequeNumber, second.chequeNumber, third.chequeNumber]).toEqual([
      'A0001',
      'A0002',
      'A0003',
    ])
  })

  it('A0099 → A0100 (padding rolls over without truncation)', async () => {
    const { service } = composeBoundary()
    const { book } = await makeBookSequence(service, {
      sequenceMode: 'alphanumeric',
      prefix: 'A',
      startSequence: 99,
      sequenceWidth: 4,
    })
    expect((await issue(service, book.id)).chequeNumber).toBe('A0099')
    expect((await issue(service, book.id)).chequeNumber).toBe('A0100')
  })

  it('A9999 → A10000 (width never truncates a longer value)', async () => {
    const { service } = composeBoundary()
    const { book } = await makeBookSequence(service, {
      sequenceMode: 'alphanumeric',
      prefix: 'A',
      startSequence: 9999,
      sequenceWidth: 4,
    })
    expect((await issue(service, book.id)).chequeNumber).toBe('A9999')
    expect((await issue(service, book.id)).chequeNumber).toBe('A10000')
  })

  it('peek never consumes: repeated peeks return the same number', async () => {
    const { service } = composeBoundary()
    const { book } = await makeBookSequence(service, { startSequence: 4567 })
    expect(await service.peekNextChequeNumber(book.id)).toBe('4567')
    expect(await service.peekNextChequeNumber(book.id)).toBe('4567')
    expect((await issue(service, book.id)).chequeNumber).toBe('4567')
  })

  it('rejects a duplicate within the same ChequeBook, scoped exactly', async () => {
    const { service } = composeBoundary()
    const { book } = await makeBookSequence(service, { sequenceMode: 'manual' })

    const first = await service.issueCheque({
      chequeBookId: book.id,
      payeeName: 'Payee',
      amount: { decimal: '10.00', currency: 'XXX' },
      chequeNumber: 'A0001',
    })
    expect(first.chequeNumber).toBe('A0001')

    await expect(
      service.issueCheque({
        chequeBookId: book.id,
        payeeName: 'Payee',
        amount: { decimal: '10.00', currency: 'XXX' },
        chequeNumber: 'A0001',
      })
    ).rejects.toBeInstanceOf(DuplicateChequeNumberError)

    // The duplicate is reported as used ONLY inside that book.
    expect(await service.hasChequeNumber(book.id, 'A0001')).toBe(true)
  })

  it('allows the SAME cheque number in two different ChequeBooks', async () => {
    const { service } = composeBoundary()
    const bank = await service.createBank({ code: 'TEST', name: 'Test Bank' })
    const accountA = await service.createBankAccount({
      bankId: bank.id,
      holderName: 'Holder A',
      accountNumber: '000111',
      currency: 'XXX',
    })
    const accountB = await service.createBankAccount({
      bankId: bank.id,
      holderName: 'Holder B',
      accountNumber: '000222',
      currency: 'XXX',
    })
    const bookA = await service.createChequeBook({
      bankAccountId: accountA.id,
      label: 'Book A',
      sequence: { sequenceMode: 'manual' },
    })
    const bookB = await service.createChequeBook({
      bankAccountId: accountB.id,
      label: 'Book B',
      sequence: { sequenceMode: 'manual' },
    })

    const one = await service.issueCheque({
      chequeBookId: bookA.id,
      payeeName: 'Payee',
      amount: { decimal: '10.00', currency: 'XXX' },
      chequeNumber: '0001',
    })
    const two = await service.issueCheque({
      chequeBookId: bookB.id,
      payeeName: 'Payee',
      amount: { decimal: '10.00', currency: 'XXX' },
      chequeNumber: '0001',
    })
    expect(one.chequeNumber).toBe('0001')
    expect(two.chequeNumber).toBe('0001')
    expect(await service.hasChequeNumber(bookA.id, '0001')).toBe(true)
    expect(await service.hasChequeNumber(bookB.id, '0001')).toBe(true)
  })

  it('enforces the exact end of the book and flips the book to exhausted', async () => {
    const { service } = composeBoundary()
    const { book } = await makeBookSequence(service, {
      sequenceMode: 'numeric',
      startSequence: 4566,
      endSequence: 4567,
    })
    expect((await issue(service, book.id)).chequeNumber).toBe('4566')
    expect((await issue(service, book.id)).chequeNumber).toBe('4567')

    await expect(issue(service, book.id)).rejects.toBeInstanceOf(ChequeBookExhaustedError)

    const reloaded = await service.findChequeBook(book.id)
    expect(reloaded?.status).toBe('exhausted')
    // …and a failed issuance consumed nothing: no third cheque exists.
    expect(await service.listCheques(book.id)).toHaveLength(2)
  })

  it('accepts manual identifiers with punctuation, verbatim', async () => {
    const { service } = composeBoundary()
    const { book } = await makeBookSequence(service, { sequenceMode: 'manual' })

    const issued = await service.issueCheque({
      chequeBookId: book.id,
      payeeName: 'Payee',
      amount: { decimal: '10.00', currency: 'XXX' },
      chequeNumber: '0012/2026-SB',
    })
    expect(issued.chequeNumber).toBe('0012/2026-SB')

    const persisted = await service.findCheque(issued.chequeId)
    expect(persisted?.chequeNumberValue).toBe('0012/2026-SB')
    expect(typeof issued.chequeNumber).toBe('string')
  })

  it('requires a manual number on manual books (no silent allocation)', async () => {
    const { service } = composeBoundary()
    const { book } = await makeBookSequence(service, { sequenceMode: 'manual' })
    await expect(
      service.issueCheque({
        chequeBookId: book.id,
        payeeName: 'Payee',
        amount: { decimal: '10.00', currency: 'XXX' },
      })
    ).rejects.toBeInstanceOf(ManualNumberRequiredError)
  })

  it('preserves leading zeros in generated and manual numbers, and in account numbers', async () => {
    const { service } = composeBoundary()

    const account = await service.createBankAccount({
      bankId: (await service.createBank({ code: 'Z', name: 'Zero Bank' })).id,
      holderName: 'Holder',
      accountNumber: '0012345',
      currency: 'XXX',
    })
    expect(account.accountNumber).toBe('0012345')

    const padded = await service.createChequeBook({
      bankAccountId: account.id,
      label: 'Padded',
      sequence: { sequenceMode: 'numeric', startSequence: 1, sequenceWidth: 4 },
    })
    expect((await issue(service, padded.id)).chequeNumber).toBe('0001')
    expect((await issue(service, padded.id)).chequeNumber).toBe('0002')

    const manual = await service.createChequeBook({
      bankAccountId: account.id,
      label: 'Manual',
      sequence: { sequenceMode: 'manual' },
    })
    const issued = await service.issueCheque({
      chequeBookId: manual.id,
      payeeName: 'Payee',
      amount: { decimal: '10.00', currency: 'XXX' },
      chequeNumber: '007',
    })
    expect(issued.chequeNumber).toBe('007')
  })

  it('keeps cheque numbers as strings end to end (never as numbers)', async () => {
    const { service } = composeBoundary()
    const { book } = await makeBookSequence(service, { startSequence: 4567 })
    const issued = await issue(service, book.id)
    expect(typeof issued.chequeNumber).toBe('string')
    const cheque = await service.findCheque(issued.chequeId)
    expect(typeof cheque?.chequeNumberValue).toBe('string')
  })

  it('uses the canonical core Money (and rejects a raw float amount)', async () => {
    const { service } = composeBoundary()
    const { book } = await makeBookSequence(service, { sequenceMode: 'manual' })

    const issued = await service.issueCheque({
      chequeBookId: book.id,
      payeeName: 'Payee',
      amount: { decimal: '1250.75', currency: 'XXX' },
      chequeNumber: '1',
    })
    const cheque = await service.findCheque(issued.chequeId)
    expect(cheque?.amount.minorUnits).toBe(125075)
    expect(cheque?.amount.currency).toBe('XXX')

    await expect(
      service.issueCheque({
        chequeBookId: book.id,
        payeeName: 'Payee',
        // Deliberate wrong type: boundary must refuse binary floats.
        amount: 12.5 as unknown as { decimal: string; currency: string },
        chequeNumber: '2',
      })
    ).rejects.toBeInstanceOf(InvalidMoneyError)
  })

  it('exposes a best-effort transaction guarantee description (honest about localStorage)', async () => {
    const { service } = composeBoundary()
    const { book } = await makeBookSequence(service, { startSequence: 1 })
    const issued = await issue(service, book.id)
    expect(issued.transactionGuarantee).toBe('best-effort')
    expect(service.transactionGuaranteeDescription()).toContain('no multi-key transaction')
  })
})

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

describe('legacy migration through the application boundary', () => {
  it('migrates accounts and checks into Bank → BankAccount → ChequeBook → Cheque', async () => {
    const { service } = composeBoundary({
      bankAccounts: [ACCOUNT_A],
      checks: [CHECK_ALPHA],
    })
    const report = await service.migrateLegacyChequeData()

    expect(report.banks).toEqual({ created: 1, replaced: 0, unchanged: 0 })
    expect(report.bankAccounts).toEqual({ created: 1, replaced: 0, unchanged: 0 })
    expect(report.chequeBooks).toEqual({ created: 1, replaced: 0, unchanged: 0 })
    expect(report.cheques).toEqual({ created: 1, replaced: 0, unchanged: 0 })
    expect(report.failures).toEqual([])

    const bank = (await service.listBanks())[0]
    const account = (await service.listBankAccounts(bank?.id))[0]
    const book = (await service.listChequeBooks(account?.id))[0]
    const cheque = (await service.listCheques(book?.id))[0]

    expect(account?.accountNumber).toBe('0012345')
    expect(account?.currency).toBe('XXX')
    expect(book?.sequence.sequenceMode).toBe('manual')
    expect(book?.reservedNumbers).toEqual(['A0099'])
    expect(cheque?.chequeNumberValue).toBe('A0099')
    expect(cheque?.chequeDate).toBe('2026-09-17')
    expect(cheque?.amount.toDecimalString()).toBe('1250.75')
    expect(cheque?.status).toBe('issued')
  })

  it('maps legacy printed+void flags into a legal implied lifecycle', async () => {
    const { service } = composeBoundary({
      bankAccounts: [ACCOUNT_A],
      checks: [{ ...CHECK_ALPHA, isPrinted: true, isVoid: true }],
    })
    await service.migrateLegacyChequeData()
    const cheque = (await service.listCheques())[0]
    expect(cheque?.status).toBe('cancelled')
    expect(cheque?.statusHistory.map((entry) => entry.to)).toEqual(['issued', 'printed', 'cancelled'])
  })

  it('allows the same cheque number across different ChequeBooks after migration', async () => {
    const accountB: LegacyBankAccountShape = {
      ...ACCOUNT_A,
      id: 'legacy-acc-2',
      name: 'Second Bank',
      accountNumber: '0099887',
    }
    const checkB: LegacyCheckShape = {
      ...CHECK_ALPHA,
      id: 'legacy-check-2',
      bankName: 'Second Bank',
      bankAccountNumber: '0099887',
    }
    const { service } = composeBoundary({
      bankAccounts: [ACCOUNT_A, accountB],
      checks: [CHECK_ALPHA, { ...checkB, checkNumber: 'A0099' }],
    })
    const report = await service.migrateLegacyChequeData()
    expect(report.failures).toEqual([])
    expect(report.cheques.created).toBe(2)

    const books = await service.listChequeBooks()
    expect(books).toHaveLength(2)
    for (const book of books) {
      expect(book.reservedNumbers).toEqual(['A0099'])
    }
  })

  it('reports unmappable records with reasons and leaves them out of the domain', async () => {
    const { service } = composeBoundary({
      bankAccounts: [
        ACCOUNT_A,
        { ...ACCOUNT_A, id: 'legacy-acc-broken', name: '', accountNumber: '777' }, // unmappable
      ],
      checks: [
        CHECK_ALPHA,
        { ...CHECK_ALPHA, id: 'legacy-check-orphan', bankAccountNumber: 'no-such-account' }, // no match
        { ...CHECK_ALPHA, id: 'legacy-check-badamount', amount: 'not-an-amount' }, // unparseable
      ],
    })
    const report = await service.migrateLegacyChequeData()

    expect(report.bankAccounts.created).toBe(1)
    expect(report.cheques.created).toBe(1)
    const kinds = report.failures.map((failure) => [failure.kind, failure.legacyId])
    expect(kinds).toContainEqual(['bankAccount', 'legacy-acc-broken'])
    expect(kinds).toContainEqual(['cheque', 'legacy-check-orphan'])
    expect(kinds).toContainEqual(['cheque', 'legacy-check-badamount'])
    expect(report.failures.every((failure) => failure.reason.length > 0)).toBe(true)
  })

  it('preserves manual punctuation identifiers and leading zeros through migration', async () => {
    const { service } = composeBoundary({
      bankAccounts: [ACCOUNT_A],
      checks: [
        { ...CHECK_ALPHA, id: 'c1', checkNumber: '0012/2026-SB' },
        { ...CHECK_ALPHA, id: 'c2', checkNumber: '0007' },
      ],
    })
    const report = await service.migrateLegacyChequeData()
    expect(report.failures).toEqual([])

    const numbers = (await service.listCheques()).map((cheque) => cheque.chequeNumberValue).sort()
    expect(numbers).toEqual(['0007', '0012/2026-SB'])
    const book = (await service.listChequeBooks())[0]
    expect(book?.reservedNumbers).toEqual(['0012/2026-SB', '0007'])
  })

  it('is idempotent: a second and third run change nothing', async () => {
    const { service } = composeBoundary({
      bankAccounts: [ACCOUNT_A],
      checks: [CHECK_ALPHA],
    })
    await service.migrateLegacyChequeData()
    const second = await service.migrateLegacyChequeData()
    const third = await service.migrateLegacyChequeData()

    for (const report of [second, third]) {
      expect(report.banks).toEqual({ created: 0, replaced: 0, unchanged: 1 })
      expect(report.bankAccounts).toEqual({ created: 0, replaced: 0, unchanged: 1 })
      expect(report.chequeBooks).toEqual({ created: 0, replaced: 0, unchanged: 1 })
      expect(report.cheques).toEqual({ created: 0, replaced: 0, unchanged: 1 })
    }
    expect(await service.listCheques()).toHaveLength(1)
  })

  it('is deterministic: clear → re-migrate reproduces byte-identical records', async () => {
    const { service, recordStore } = composeBoundary({
      bankAccounts: [ACCOUNT_A],
      checks: [{ ...CHECK_ALPHA, isPrinted: true }],
    })
    await service.migrateLegacyChequeData()
    const firstKeys = await recordStore.keys()
    const firstSnapshot = new Map(
      await Promise.all(firstKeys.map(async (key) => [key, await recordStore.get(key)] as const))
    )

    await service.clearDomainData()
    await service.migrateLegacyChequeData()
    const secondKeys = await recordStore.keys()

    expect(secondKeys.sort()).toEqual(firstKeys.sort())
    for (const key of secondKeys) {
      expect(await recordStore.get(key)).toEqual(firstSnapshot.get(key))
    }
  })

  it('is non-destructive: migration never writes legacy collection keys', async () => {
    const { service, recordStore } = composeBoundary({
      bankAccounts: [ACCOUNT_A],
      checks: [CHECK_ALPHA],
    })
    // Seed "legacy-looking" keys inside the shared store to prove they survive untouched.
    await recordStore.set('bankAccounts', 'LEGACY-SENTINEL')
    await recordStore.set('checkList', 'LEGACY-SENTINEL')

    await service.migrateLegacyChequeData()

    expect(await recordStore.get('bankAccounts')).toBe('LEGACY-SENTINEL')
    expect(await recordStore.get('checkList')).toBe('LEGACY-SENTINEL')
    expect(
      (await recordStore.keys()).every(
        (key) => key.startsWith('test:cheque:v1:') || ['bankAccounts', 'checkList'].includes(key)
      )
    ).toBe(true)
  })

  it('is reversible: clearDomainData removes only the domain namespace', async () => {
    const { service, recordStore } = composeBoundary({
      bankAccounts: [ACCOUNT_A],
      checks: [CHECK_ALPHA],
    })
    await recordStore.set('bankAccounts', 'LEGACY-SENTINEL')
    await service.migrateLegacyChequeData()
    expect(service.diagnostics().counts?.cheque).toBe(1)

    const removed = await service.clearDomainData()
    expect(removed).toBeGreaterThan(0)
    expect(service.diagnostics().counts).toEqual({ bank: 0, bankAccount: 0, chequeBook: 0, cheque: 0 })
    expect(await recordStore.get('bankAccounts')).toBe('LEGACY-SENTINEL')
    expect(await service.listCheques()).toEqual([])
  })

  it('syncLegacyCheck mirrors one saved legacy check idempotently', async () => {
    const { service } = composeBoundary({ bankAccounts: [ACCOUNT_A] })

    const first = await service.syncLegacyCheck(CHECK_ALPHA)
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(first.chequeId).toBe('cheque:legacy:legacy-check-1')
      expect(first.chequeNumber).toBe('A0099')
      expect(first.state).toBe('created')
    }

    const again = await service.syncLegacyCheck(CHECK_ALPHA)
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.state).toBe('unchanged')
    expect(await service.listCheques()).toHaveLength(1)
  })

  it('syncLegacyCheck reports — never guesses — when no account matches', async () => {
    const { service } = composeBoundary({ bankAccounts: [] })
    const result = await service.syncLegacyCheck(CHECK_ALPHA)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.reason).toContain('no legacy bank account matches')
    }
    expect(await service.listCheques()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Full composition over the real secureStorage adapter
// ---------------------------------------------------------------------------

class MemoryStorage implements Storage {
  private readonly records = new Map<string, string>()
  get length(): number {
    return this.records.size
  }
  clear(): void {
    this.records.clear()
  }
  getItem(key: string): string | null {
    return this.records.get(key) ?? null
  }
  key(index: number): string | null {
    return [...this.records.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.records.delete(key)
  }
  setItem(key: string, value: string): void {
    this.records.set(key, String(value))
  }
}

describe('store bridge: recordSavedLegacyCheck (used by the check store save path)', () => {
  beforeEach(() => {
    ;(globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage()
    globalThis.localStorage.setItem('encryption_enabled', 'false')
    secureStorage.initialize(null)
  })

  it('mirrors a saved check through the default composition and stays idempotent', async () => {
    const { recordSavedLegacyCheck, resetChequeDomainForTests } = await import('../index')
    resetChequeDomainForTests()
    await secureStorage.set('bankAccounts', JSON.stringify([ACCOUNT_A]))

    const first = await recordSavedLegacyCheck(CHECK_ALPHA)
    expect(first.mirrored).toBe(true)
    expect(first.chequeId).toBe('cheque:legacy:legacy-check-1')
    expect(first.chequeNumber).toBe('A0099')

    const again = await recordSavedLegacyCheck(CHECK_ALPHA)
    expect(again.mirrored).toBe(true)
    resetChequeDomainForTests()
  })

  it('never throws and reports when the check cannot be mirrored', async () => {
    const { recordSavedLegacyCheck, resetChequeDomainForTests } = await import('../index')
    resetChequeDomainForTests()
    await secureStorage.set('bankAccounts', JSON.stringify([]))

    const outcome = await recordSavedLegacyCheck(CHECK_ALPHA)
    expect(outcome.mirrored).toBe(false)
    expect(outcome.reason).toContain('no legacy bank account matches')
    resetChequeDomainForTests()
  })
})

describe('boundary over the secureStorage adapter (shared localStorage)', () => {
  beforeEach(() => {
    ;(globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage()
    globalThis.localStorage.setItem('encryption_enabled', 'false')
    secureStorage.initialize(null)
  })

  it('migrates out of the real legacy keys without altering them, then reverses cleanly', async () => {
    const accountsJson = JSON.stringify([ACCOUNT_A])
    const checksJson = JSON.stringify([CHECK_ALPHA])
    await secureStorage.set('bankAccounts', accountsJson)
    await secureStorage.set('checkList', checksJson)

    const recordStore = new SecureStorageRecordStore(secureStorage)
    const service = new ChequeDomainService({
      core: new ChequeCore({
        unitOfWorkFactory: new ChequePersistence({ store: recordStore }),
      }),
      legacySource: createSecureStorageLegacySource(secureStorage),
      recordStore,
    })

    const report = await service.migrateLegacyChequeData()
    expect(report.cheques.created).toBe(1)

    // Domain records landed in the versioned shadow namespace…
    const keys = await recordStore.keys()
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.every((key) => key.startsWith(DOMAIN_KEY_PREFIX))).toBe(true)

    // …legacy blobs are byte-identical (migration is read-only on them)…
    expect(globalThis.localStorage.getItem('bankAccounts')).toBe(accountsJson)
    expect(globalThis.localStorage.getItem('checkList')).toBe(checksJson)

    // …reversal removes the namespace and nothing else.
    await service.clearDomainData()
    expect(await recordStore.keys()).toEqual([])
    expect(globalThis.localStorage.getItem('bankAccounts')).toBe(accountsJson)
    expect(globalThis.localStorage.getItem('checkList')).toBe(checksJson)
  })
})
