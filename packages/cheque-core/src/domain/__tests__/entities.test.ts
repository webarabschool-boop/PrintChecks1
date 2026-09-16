import { describe, expect, it } from 'vitest'
import { Bank } from '../entities/Bank'
import { BankAccount } from '../entities/BankAccount'
import { ChequeBook } from '../entities/ChequeBook'
import { Cheque } from '../entities/Cheque'
import { Money } from '../value-objects/Money'
import {
  AggregateIntegrityError,
  ChequeBookExhaustedError,
  ChequeBookNotActiveError,
  DuplicateChequeNumberError,
  InvalidChequeBookSequenceError,
  InvalidChequeNumberError,
  RequiredFieldError,
} from '../errors'

const NOW = '2026-01-15T10:00:00.000Z'

function makeBank(overrides: Partial<Parameters<typeof Bank.create>[0]> = {}) {
  return Bank.create({ id: 'bnk_1', code: 'NBE', name: 'National Bank of Egypt', createdAt: NOW, ...overrides })
}

function makeAccount(overrides: Partial<Parameters<typeof BankAccount.create>[0]> = {}) {
  return BankAccount.create({
    id: 'acc_1',
    bankId: 'bnk_1',
    holderName: 'Acme Trading',
    accountNumber: '0012345',
    currency: 'EGP',
    createdAt: NOW,
    ...overrides,
  })
}

function makeBook(overrides: Partial<Parameters<typeof ChequeBook.create>[0]> = {}) {
  return ChequeBook.create({
    id: 'cbk_1',
    bankAccountId: 'acc_1',
    label: 'Book 1',
    sequence: { sequenceMode: 'numeric', startSequence: 4567, endSequence: 4576 },
    createdAt: NOW,
    ...overrides,
  })
}

/**
 * Required test list item 1: bank creation, account creation, cheque book creation and
 * the relationships between them.
 */
describe('Bank / BankAccount / ChequeBook / Cheque relationships', () => {
  describe('Bank', () => {
    it('creates with required identity fields', () => {
      const bank = makeBank()
      expect(bank.id).toBe('bnk_1')
      expect(bank.code).toBe('NBE')
      expect(bank.name).toBe('National Bank of Egypt')
      expect(bank.isActive).toBe(true)
      expect(bank.createdAt).toBe(NOW)
    })

    it('rejects a missing id, code or name', () => {
      expect(() => Bank.create({ id: '', code: 'NBE', name: 'X', createdAt: NOW })).toThrow(
        RequiredFieldError
      )
      expect(() => Bank.create({ id: 'b', code: '  ', name: 'X', createdAt: NOW })).toThrow(
        /Bank.code/
      )
      expect(() => Bank.create({ id: 'b', code: 'NBE', name: '', createdAt: NOW })).toThrow(
        /Bank.name/
      )
    })

    it('normalises and validates the optional country code', () => {
      expect(makeBank({ country: 'eg' }).country).toBe('EG')
      expect(makeBank().country).toBeNull()
      expect(() => Bank.fromJSON({ ...makeBank().toData(), country: 'EGY' })).toThrow(
        AggregateIntegrityError
      )
    })

    it('prefers the localised display name when present', () => {
      expect(makeBank({ nameLocal: 'البنك الأهلي المصري' }).displayName()).toBe('البنك الأهلي المصري')
      expect(makeBank().displayName()).toBe('National Bank of Egypt')
    })

    it('activates and deactivates immutably', () => {
      const bank = makeBank()
      const off = bank.deactivate('2026-02-01T00:00:00.000Z')
      expect(off.isActive).toBe(false)
      expect(bank.isActive).toBe(true)
      expect(off.activate(NOW).isActive).toBe(true)
    })

    it('round-trips through JSON', () => {
      const bank = makeBank({ nameLocal: 'X', country: 'EG' })
      const restored = Bank.fromJSON(JSON.parse(JSON.stringify(bank)))
      expect(restored.toData()).toEqual(bank.toData())
    })
  })

  describe('BankAccount', () => {
    it('belongs to a bank by identity', () => {
      const bank = makeBank()
      const account = makeAccount({ bankId: bank.id })
      expect(account.bankId).toBe(bank.id)
    })

    it('refuses to exist without a bank', () => {
      // create() rejects the empty reference outright; fromJSON() surfaces the
      // relationship rule, since persisted data cannot be trusted to have been checked.
      expect(() => makeAccount({ bankId: '' })).toThrow(RequiredFieldError)
      expect(() =>
        BankAccount.fromJSON({ ...makeAccount().toData(), bankId: '' })
      ).toThrow(/must belong to a Bank/)
      expect(() =>
        BankAccount.fromJSON({ ...makeAccount().toData(), bankId: '' })
      ).toThrow(AggregateIntegrityError)
    })

    it('preserves the account number exactly, including leading zeros', () => {
      const account = makeAccount({ accountNumber: '0012345' })
      expect(account.accountNumber).toBe('0012345')
      expect(account.accountNumber.length).toBe(7)
    })

    it('treats leading-zero variants as different accounts', () => {
      const a = makeAccount({ id: 'acc_a', accountNumber: '0012345' })
      const b = makeAccount({ id: 'acc_b', accountNumber: '12345' })
      expect(a.accountNumber).not.toBe(b.accountNumber)
    })

    it('masks the account number for display', () => {
      expect(makeAccount({ accountNumber: '0012345' }).maskedAccountNumber()).toBe('****2345')
      expect(makeAccount({ accountNumber: '12' }).maskedAccountNumber()).toBe('12')
    })

    it('normalises currency and rejects malformed codes', () => {
      expect(makeAccount({ currency: 'egp' }).currency).toBe('EGP')
      expect(() => makeAccount({ currency: 'EG' })).toThrow(/ISO 4217/)
    })

    it('accepts account types outside the legacy hardcoded union', () => {
      // The old model only allowed 'checking' | 'savings' | 'business'.
      expect(() => makeAccount({ accountType: 'current' })).not.toThrow()
      expect(() => makeAccount({ accountType: 'جاري' })).not.toThrow()
      expect(makeAccount({ accountType: null }).accountType).toBeNull()
    })

    it('validates required fields', () => {
      expect(() => makeAccount({ holderName: '' })).toThrow(/holderName/)
      expect(() => makeAccount({ accountNumber: '  ' })).toThrow(/accountNumber/)
    })
  })

  describe('ChequeBook', () => {
    it('belongs to a bank account', () => {
      const account = makeAccount()
      const book = makeBook({ bankAccountId: account.id })
      expect(book.bankAccountId).toBe(account.id)
    })

    it('refuses to exist without an account', () => {
      expect(() => makeBook({ bankAccountId: '' })).toThrow(RequiredFieldError)
      expect(() =>
        ChequeBook.fromJSON({ ...makeBook().toData(), bankAccountId: '' })
      ).toThrow(/must belong to a BankAccount/)
    })

    it('owns its own sequence configuration', () => {
      const book = makeBook()
      expect(book.sequence.prefix).toBe('')
      expect(book.sequence.startSequence).toBe(4567)
      expect(book.sequence.currentSequence).toBe(4567)
      expect(book.sequence.endSequence).toBe(4576)
      expect(book.remaining).toBe(10)
    })

    it('defaults to an active, numeric book starting at 1', () => {
      const book = ChequeBook.create({ id: 'cbk_x', bankAccountId: 'acc_1', label: 'B', createdAt: NOW })
      expect(book.status).toBe('active')
      expect(book.sequence.sequenceMode).toBe('numeric')
      expect(book.sequence.startSequence).toBe(1)
      expect(book.isIssuable).toBe(true)
    })

    it('validates its sequence at construction', () => {
      expect(() =>
        makeBook({ sequence: { startSequence: 100, endSequence: 10 } })
      ).toThrow(InvalidChequeBookSequenceError)
    })

    it('rejects reserved numbers that do not match the book prefix', () => {
      expect(() =>
        ChequeBook.fromJSON({
          ...makeBook({
            sequence: { sequenceMode: 'alphanumeric', prefix: 'A', startSequence: 1 },
          }).toData(),
          reservedNumbers: ['B0001'],
        })
      ).toThrow(/does not match book prefix/)
    })

    it('rejects duplicate reserved numbers', () => {
      expect(() =>
        ChequeBook.fromJSON({ ...makeBook().toData(), reservedNumbers: ['4567', '4567'] })
      ).toThrow(/duplicate entries in reservedNumbers/)
    })

    it('records a template reference without inventing any physical geometry', () => {
      const book = makeBook({ templateId: 'tpl_nbe_personal' })
      expect(book.templateId).toBe('tpl_nbe_personal')
      // The book carries no dimensions, coordinates or MICR placement of its own.
      expect(Object.keys(book.toData())).not.toContain('widthMm')
      expect(Object.keys(book.toData())).not.toContain('fields')
      expect(Object.keys(book.toData())).not.toContain('micr')
    })

    it('round-trips through JSON preserving the sequence cursor', () => {
      const book = makeBook()
      const { book: advanced } = book.allocateNextChequeNumber(NOW)
      const restored = ChequeBook.fromJSON(JSON.parse(JSON.stringify(advanced)))
      expect(restored.toData()).toEqual(advanced.toData())
      expect(restored.sequence.currentSequence).toBe(4568)
    })
  })

  describe('Cheque', () => {
    it('belongs to a cheque book', () => {
      const book = makeBook()
      const cheque = Cheque.create({
        id: 'chq_1',
        chequeBookId: book.id,
        bankAccountId: book.bankAccountId,
        chequeNumber: '4567',
        amount: Money.fromDecimalString('250.00', 'EGP'),
        payeeName: 'Supplier Co',
        createdAt: NOW,
      })

      expect(cheque.chequeBookId).toBe(book.id)
      expect(cheque.bankAccountId).toBe('acc_1')
      expect(cheque.chequeNumberValue).toBe('4567')
      expect(cheque.direction).toBe('outgoing')
    })

    it('refuses an outgoing cheque with no book', () => {
      expect(() =>
        Cheque.create({
          id: 'chq_1',
          chequeNumber: '4567',
          amount: Money.fromDecimalString('1.00', 'EGP'),
          payeeName: 'X',
          createdAt: NOW,
        })
      ).toThrow(/must belong to a ChequeBook/)
    })

    it('refuses an incoming cheque that references a book', () => {
      expect(() =>
        Cheque.create({
          id: 'chq_2',
          direction: 'incoming',
          chequeBookId: 'cbk_1',
          chequeNumber: '999',
          amount: Money.fromDecimalString('1.00', 'EGP'),
          payeeName: 'Us',
          drawerName: 'Someone',
          createdAt: NOW,
        })
      ).toThrow(/must not reference a ChequeBook/)
    })

    it('allows an incoming cheque with no book, recording the issuer verbatim', () => {
      const cheque = Cheque.create({
        id: 'chq_3',
        direction: 'incoming',
        chequeNumber: 'A0001',
        amount: Money.fromDecimalString('75.25', 'EGP'),
        payeeName: 'Us',
        drawerName: 'Customer',
        issuingBankName: 'Some Bank We Do Not Model',
        createdAt: NOW,
      })

      expect(cheque.chequeBookId).toBeNull()
      expect(cheque.issuingBankName).toBe('Some Bank We Do Not Model')
    })

    it('stores the amount as Money, never as a raw number', () => {
      const cheque = Cheque.create({
        id: 'chq_1',
        chequeBookId: 'cbk_1',
        chequeNumber: '4567',
        amount: Money.fromDecimalString('0.1', 'EGP'),
        payeeName: 'X',
        createdAt: NOW,
      })
      expect(cheque.amount).toBeInstanceOf(Money)
      expect(cheque.amount.toDecimalString()).toBe('0.10')
      expect(cheque.toData().amount).toEqual({ minorUnits: 10, currency: 'EGP' })

      expect(() =>
        Cheque.create({
          id: 'chq_1',
          chequeBookId: 'cbk_1',
          chequeNumber: '4567',
          amount: 0.1 as never,
          payeeName: 'X',
          createdAt: NOW,
        })
      ).toThrow(/must be an instance of the Money value object/)
    })

    it('keeps the cheque number as an exact string in its persisted form', () => {
      const cheque = Cheque.create({
        id: 'chq_1',
        chequeBookId: 'cbk_1',
        chequeNumber: 'A0001',
        amount: Money.zero('EGP'),
        payeeName: 'X',
        createdAt: NOW,
      })
      expect(cheque.toData().chequeNumber).toBe('A0001')
      expect(typeof cheque.toData().chequeNumber).toBe('string')
      expect(JSON.stringify(cheque)).toContain('"chequeNumber":"A0001"')
    })

    it('starts as a draft with a single history entry by default', () => {
      const cheque = Cheque.create({
        id: 'chq_1',
        chequeBookId: 'cbk_1',
        chequeNumber: '4567',
        amount: Money.zero('EGP'),
        payeeName: 'X',
        createdAt: NOW,
      })
      expect(cheque.status).toBe('draft')
      expect(cheque.statusHistory).toHaveLength(1)
      expect(cheque.statusHistory[0]).toMatchObject({ from: null, to: 'draft', occurredAt: NOW })
    })

    it('separates the internal id from the cheque number', () => {
      const cheque = Cheque.create({
        id: 'chq_abc123',
        chequeBookId: 'cbk_1',
        chequeNumber: '4567',
        amount: Money.zero('EGP'),
        payeeName: 'X',
        createdAt: NOW,
      })
      expect(cheque.id).not.toBe(cheque.chequeNumberValue)
    })

    it('validates required fields and the cheque date', () => {
      const base = {
        id: 'chq_1',
        chequeBookId: 'cbk_1',
        chequeNumber: '4567',
        amount: Money.zero('EGP'),
        payeeName: 'X',
        createdAt: NOW,
      }
      expect(() => Cheque.create({ ...base, payeeName: '  ' })).toThrow(/payeeName/)
      expect(() => Cheque.create({ ...base, chequeNumber: '' })).toThrow(InvalidChequeNumberError)
      expect(() => Cheque.create({ ...base, chequeDate: '15/01/2026' })).toThrow(/non-ISO chequeDate/)
    })

    it('rejects a broken status history on deserialisation', () => {
      const cheque = Cheque.create({
        id: 'chq_1',
        chequeBookId: 'cbk_1',
        chequeNumber: '4567',
        amount: Money.zero('EGP'),
        payeeName: 'X',
        createdAt: NOW,
      })
      expect(() =>
        Cheque.fromJSON({
          ...cheque.toData(),
          statusHistory: [{ from: null, to: 'issued', occurredAt: NOW }, { from: null, to: 'cleared', occurredAt: NOW }],
        })
      ).toThrow(/broken status history/)
    })

    it('round-trips through JSON', () => {
      const cheque = Cheque.create({
        id: 'chq_1',
        chequeBookId: 'cbk_1',
        chequeNumber: 'A0001',
        amount: Money.fromDecimalString('1234.56', 'EGP'),
        payeeName: 'Supplier',
        memo: 'Invoice 42',
        createdAt: NOW,
      })
      const restored = Cheque.fromJSON(JSON.parse(JSON.stringify(cheque)))
      expect(restored.toData()).toEqual(cheque.toData())
      expect(restored.chequeNumberValue).toBe('A0001')
      expect(restored.amount.toDecimalString()).toBe('1234.56')
    })
  })

  describe('cheque number scoping', () => {
    it('rejects a duplicate number WITHIN the same book (required case 10)', () => {
      const book = makeBook()
      const first = book.reserveManualChequeNumber
      expect(typeof first).toBe('function')

      const manual = ChequeBook.create({
        id: 'cbk_manual',
        bankAccountId: 'acc_1',
        label: 'Manual',
        sequence: { sequenceMode: 'manual' },
        createdAt: NOW,
      })

      const a = manual.reserveManualChequeNumber('A0001', NOW)
      expect(a.chequeNumber.value).toBe('A0001')

      expect(() => a.book.reserveManualChequeNumber('A0001', NOW)).toThrow(
        DuplicateChequeNumberError
      )
      expect(() => a.book.reserveManualChequeNumber('A0001', NOW)).toThrow(/already exists/)
    })

    it('allows the SAME number in two different books (required case 11)', () => {
      const bookA = ChequeBook.create({
        id: 'cbk_A',
        bankAccountId: 'acc_1',
        label: 'Book A',
        sequence: { sequenceMode: 'numeric', startSequence: 4567 },
        createdAt: NOW,
      })
      const bookB = ChequeBook.create({
        id: 'cbk_B',
        bankAccountId: 'acc_2',
        label: 'Book B',
        sequence: { sequenceMode: 'numeric', startSequence: 4567 },
        createdAt: NOW,
      })

      const a = bookA.allocateNextChequeNumber(NOW)
      const b = bookB.allocateNextChequeNumber(NOW)

      expect(a.chequeNumber.value).toBe('4567')
      expect(b.chequeNumber.value).toBe('4567')
      expect(a.chequeNumber.value).toBe(b.chequeNumber.value)

      // Each book still tracks its own reservations independently.
      expect(a.book.hasReserved('4567')).toBe(true)
      expect(b.book.hasReserved('4567')).toBe(true)
      expect(bookA.hasReserved('4567')).toBe(false)
    })

    it('allows the same number across two accounts at two different banks', () => {
      const bankX = makeBank({ id: 'bnk_x', code: 'X' })
      const bankY = makeBank({ id: 'bnk_y', code: 'Y' })
      const accountX = makeAccount({ id: 'acc_x', bankId: bankX.id })
      const accountY = makeAccount({ id: 'acc_y', bankId: bankY.id })

      const bookX = makeBook({ id: 'cbk_x', bankAccountId: accountX.id, sequence: { startSequence: 100 } })
      const bookY = makeBook({ id: 'cbk_y', bankAccountId: accountY.id, sequence: { startSequence: 100 } })

      expect(bookX.peekNextChequeNumber().value).toBe(bookY.peekNextChequeNumber().value)
    })
  })

  describe('book status guards', () => {
    it('refuses to issue from a non-active book', () => {
      const retired = makeBook().retire(NOW)
      expect(retired.status).toBe('retired')
      expect(retired.isIssuable).toBe(false)
      expect(() => retired.allocateNextChequeNumber(NOW)).toThrow(ChequeBookNotActiveError)
    })

    it('marks the book exhausted automatically at the end sequence', () => {
      let book = ChequeBook.create({
        id: 'cbk_1',
        bankAccountId: 'acc_1',
        label: 'Small',
        sequence: { startSequence: 1, endSequence: 2 },
        createdAt: NOW,
      })

      book = book.allocateNextChequeNumber(NOW).book
      expect(book.status).toBe('active')

      book = book.allocateNextChequeNumber(NOW).book
      expect(book.status).toBe('exhausted')
      expect(book.remaining).toBe(0)
      expect(() => book.allocateNextChequeNumber(NOW)).toThrow(ChequeBookExhaustedError)
    })

    it('never reactivates a lost or destroyed book', () => {
      const book = makeBook()
      expect(() => book.reportLost(NOW).reactivate(NOW)).toThrow(/can never be reactivated/)
      expect(() => book.reportDestroyed(NOW).reactivate(NOW)).toThrow(/can never be reactivated/)
    })

    it('reactivates a retired book that still has numbers', () => {
      const book = makeBook().retire(NOW)
      expect(book.reactivate(NOW).status).toBe('active')
    })

    it('refuses to reactivate an exhausted book', () => {
      let book = ChequeBook.create({
        id: 'cbk_1',
        bankAccountId: 'acc_1',
        label: 'One',
        sequence: { startSequence: 1, endSequence: 1 },
        createdAt: NOW,
      })
      book = book.allocateNextChequeNumber(NOW).book
      expect(book.status).toBe('exhausted')
      expect(() => book.reactivate(NOW)).toThrow(ChequeBookExhaustedError)
    })
  })

  describe('cancelled numbers are never reused', () => {
    it('keeps the reservation after the cheque that used it is cancelled', () => {
      let book = makeBook()
      const allocated = book.allocateNextChequeNumber(NOW)
      book = allocated.book

      const cheque = Cheque.create({
        id: 'chq_1',
        chequeBookId: book.id,
        chequeNumber: allocated.chequeNumber.value,
        amount: Money.fromDecimalString('10.00', 'EGP'),
        payeeName: 'X',
        initialStatus: 'issued',
        createdAt: NOW,
      })

      const cancelled = cheque.transitionTo('cancelled', { occurredAt: NOW, reason: 'spoiled' })
      expect(cancelled.status).toBe('cancelled')

      // The number stays reserved and the cursor stays advanced.
      expect(book.hasReserved('4567')).toBe(true)
      expect(book.sequence.currentSequence).toBe(4568)
      expect(book.peekNextChequeNumber().value).toBe('4568')
    })
  })
})
