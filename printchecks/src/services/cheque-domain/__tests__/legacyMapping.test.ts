import { describe, expect, it } from 'vitest'
import { Money } from '@printchecks/cheque-core'

import {
  LEGACY_MIGRATION_CURRENCY,
  deriveBankCode,
  legacyBankAccountId,
  legacyBankId,
  legacyChequeId,
  legacyMigrationChequeBookId,
  mapLegacyAmount,
  mapLegacyBankAccount,
  mapLegacyCheque,
  mapLegacyChequeDate,
  mapLegacyChequeNumber,
  matchLegacyAccountForCheck,
  normaliseBankName,
  toIsoTimestamp,
  type LegacyBankAccountShape,
  type LegacyCheckShape,
} from '../legacyMapping'

const ACCOUNT: LegacyBankAccountShape = {
  id: 'legacy-acc-1',
  name: 'First National',
  accountHolderName: 'Jane Smith',
  accountNumber: '0012345',
  accountType: 'business',
  isDefault: true,
  createdAt: '2026-01-05T08:00:00.000Z',
  updatedAt: '2026-01-05T08:00:00.000Z',
}

const CHECK: LegacyCheckShape = {
  id: 'legacy-check-1',
  checkNumber: 'A0001',
  amount: '1250.75',
  payTo: 'Acme Corp',
  bankName: 'First National',
  bankAccountNumber: '0012345',
  date: '2026-02-01',
  memo: 'invoice 44',
  isVoid: false,
  isPrinted: true,
  createdAt: '2026-02-01T10:00:00.000Z',
  updatedAt: '2026-02-02T10:00:00.000Z',
}

describe('deterministic identities', () => {
  it('derives the same ids for the same legacy input on every call', () => {
    expect(legacyBankId('First National')).toBe(legacyBankId('First National'))
    expect(legacyBankId('First National')).toBe('bank:legacy:first national')
    expect(legacyBankAccountId('legacy-acc-1')).toBe('bankAccount:legacy:legacy-acc-1')
    expect(legacyMigrationChequeBookId('legacy-acc-1')).toBe('chequeBook:legacy:legacy-acc-1')
    expect(legacyChequeId('legacy-check-1')).toBe('cheque:legacy:legacy-check-1')
  })

  it('shares one Bank identity across formatting-equal names only', () => {
    expect(legacyBankId('First   National')).toBe(legacyBankId('first national'))
    expect(legacyBankId('First National Bank')).not.toBe(legacyBankId('First National'))
  })

  it('derives a stable internal bank code without inventing data', () => {
    expect(deriveBankCode('first national')).toBe('FIRSTNATIONA')
    expect(deriveBankCode('!!!')).toBe('LEGACY')
  })
})

describe('mapLegacyBankAccount', () => {
  it('maps a full legacy account with preserved, exact values', () => {
    const result = mapLegacyBankAccount(ACCOUNT)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.bank).toMatchObject({
      id: 'bank:legacy:first national',
      name: 'First National',
      country: null,
      isActive: true,
    })
    expect(result.value.bankAccount).toMatchObject({
      id: 'bankAccount:legacy:legacy-acc-1',
      bankId: 'bank:legacy:first national',
      holderName: 'Jane Smith',
      // Leading zeros preserved — exact string, never numerically coerced.
      accountNumber: '0012345',
      currency: LEGACY_MIGRATION_CURRENCY,
      accountType: 'business',
      isDefault: true,
    })
    expect(result.value.chequeBook).toMatchObject({
      id: 'chequeBook:legacy:legacy-acc-1',
      bankAccountId: 'bankAccount:legacy:legacy-acc-1',
    })
    // Currency must be the explicit "no currency" sentinel, never a guessed real one.
    expect(result.value.bankAccount.currency).toBe('XXX')
  })

  it('is deterministic: repeated mapping is byte-identical', () => {
    const first = mapLegacyBankAccount(ACCOUNT)
    const second = mapLegacyBankAccount(ACCOUNT)
    expect(first).toEqual(second)
  })

  it('reports unmappable accounts instead of guessing', () => {
    const cases: Array<[LegacyBankAccountShape, string]> = [
      [{ name: 'First National', accountHolderName: 'Jane', accountNumber: '001', createdAt: '2026-01-01T00:00:00.000Z' }, 'missing legacy id'],
      [{ id: 'a1', accountHolderName: 'Jane', accountNumber: '001', createdAt: '2026-01-01T00:00:00.000Z' }, 'missing bank name'],
      [{ id: 'a1', name: 'First National', accountHolderName: 'Jane', createdAt: '2026-01-01T00:00:00.000Z' }, 'missing account number'],
      [{ id: 'a1', name: 'First National', accountNumber: '001', createdAt: '2026-01-01T00:00:00.000Z' }, 'missing account holder name'],
      [{ id: 'a1', name: 'First National', accountHolderName: 'Jane', accountNumber: '001' }, 'createdAt'],
    ]
    for (const [input, reasonIncludes] of cases) {
      const result = mapLegacyBankAccount(input)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.failure.kind).toBe('bankAccount')
      expect(result.failure.reason).toContain(reasonIncludes)
    }
  })
})

describe('mapLegacyChequeNumber', () => {
  it('preserves prefixes, leading zeros and punctuation exactly', () => {
    for (const raw of ['4567', 'A4567', 'A0001', '0099', '0012/2026-SB', 'CHQ-42.A']) {
      const result = mapLegacyChequeNumber(raw)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value).toBe(raw)
    }
  })

  it('never accepts a non-string cheque number', () => {
    expect(mapLegacyChequeNumber(4567).ok).toBe(false)
    expect(mapLegacyChequeNumber(null).ok).toBe(false)
    expect(mapLegacyChequeNumber(undefined).ok).toBe(false)
    expect(mapLegacyChequeNumber('').ok).toBe(false)
    expect(mapLegacyChequeNumber(' 4567 ').ok).toBe(false)
  })
})

describe('mapLegacyAmount', () => {
  it('builds canonical core Money from exact decimal strings', () => {
    const result = mapLegacyAmount('1250.75')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBeInstanceOf(Money)
    expect(result.value.minorUnits).toBe(125075)
    expect(result.value.currency).toBe('XXX')
    expect(result.value.toDecimalString()).toBe('1250.75')
  })

  it('strips unambiguous thousands separators and nothing else', () => {
    const grouped = mapLegacyAmount('1,234,567.89')
    expect(grouped.ok).toBe(true)
    if (grouped.ok) expect(grouped.value.toDecimalString()).toBe('1234567.89')
    expect(mapLegacyAmount('12,34,567.89').ok).toBe(false)
  })

  it('reproduces the legacy number as its shortest exact decimal, with no float arithmetic', () => {
    const result = mapLegacyAmount(500)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.toDecimalString()).toBe('500.00')
    expect(mapLegacyAmount(Number.POSITIVE_INFINITY).ok).toBe(false)
  })

  it('rejects amounts it cannot interpret instead of zero-filling', () => {
    expect(mapLegacyAmount('abc').ok).toBe(false)
    expect(mapLegacyAmount('').ok).toBe(false)
    expect(mapLegacyAmount(null).ok).toBe(false)
    expect(mapLegacyAmount({ value: 10 }).ok).toBe(false)
  })

  it('carries the caller-specified currency without guessing', () => {
    const result = mapLegacyAmount('10.5', 'EGP')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.currency).toBe('EGP')
  })
})

describe('mapLegacyChequeDate', () => {
  it('passes ISO dates through verbatim', () => {
    const result = mapLegacyChequeDate('2026-02-01')
    expect(result).toEqual({ ok: true, value: '2026-02-01' })
  })

  it('interprets the legacy en-US m/d/yyyy writer format deterministically', () => {
    expect(mapLegacyChequeDate('9/17/2026')).toEqual({ ok: true, value: '2026-09-17' })
    expect(mapLegacyChequeDate('12/31/2025')).toEqual({ ok: true, value: '2025-12-31' })
  })

  it('converts real Date instances at face value', () => {
    const result = mapLegacyChequeDate(new Date(Date.UTC(2026, 1, 3, 10, 30)))
    expect(result).toEqual({ ok: true, value: '2026-02-03' })
  })

  it('rejects ambiguous or impossible dates rather than guessing', () => {
    expect(mapLegacyChequeDate('02/30/2026').ok).toBe(false)
    expect(mapLegacyChequeDate('17-09-2026').ok).toBe(false)
    expect(mapLegacyChequeDate('tomorrow').ok).toBe(false)
    expect(mapLegacyChequeDate(undefined).ok).toBe(false)
  })
})

describe('mapLegacyCheque', () => {
  const context = { chequeBookId: 'chequeBook:legacy:legacy-acc-1', bankAccountId: 'bankAccount:legacy:legacy-acc-1' }

  it('maps a printed legacy check into the domain with lifecycle replay', () => {
    const result = mapLegacyCheque(CHECK, context)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.cheque).toMatchObject({
      id: 'cheque:legacy:legacy-check-1',
      chequeBookId: context.chequeBookId,
      bankAccountId: context.bankAccountId,
      chequeNumber: 'A0001',
      chequeDate: '2026-02-01',
      payeeName: 'Acme Corp',
      memo: 'invoice 44',
      createdAt: CHECK.createdAt,
    })
    expect(result.value.cheque.amount.toDecimalString()).toBe('1250.75')
    expect(result.value.transitions).toEqual([
      { to: 'printed', occurredAt: CHECK.updatedAt, reason: 'legacy isPrinted flag' },
    ])
  })

  it('replays void as issued → printed → cancelled, staying legal at every step', () => {
    const result = mapLegacyCheque({ ...CHECK, isVoid: true }, context)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.transitions.map((t) => t.to)).toEqual(['printed', 'cancelled'])
  })

  it('keeps en-US written dates and punctuation cheque numbers intact', () => {
    const result = mapLegacyCheque(
      { ...CHECK, checkNumber: '0012/2026-SB', date: '9/17/2026' },
      context
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.cheque.chequeNumber).toBe('0012/2026-SB')
    expect(result.value.cheque.chequeDate).toBe('2026-09-17')
  })

  it('is deterministic: repeated mapping is byte-identical', () => {
    const first = mapLegacyCheque(CHECK, context)
    const second = mapLegacyCheque(CHECK, context)
    expect(JSON.stringify(first, (key, value) => (value instanceof Money ? value.toJSON() : value))).toBe(
      JSON.stringify(second, (key, value) => (value instanceof Money ? value.toJSON() : value))
    )
  })

  it('reports unmappable checks instead of guessing', () => {
    const cases: Array<[LegacyCheckShape, string]> = [
      [{ ...CHECK, id: undefined }, 'missing legacy id'],
      [{ ...CHECK, checkNumber: undefined }, 'check number'],
      [{ ...CHECK, payTo: '' }, 'payee'],
      [{ ...CHECK, amount: 'not-a-number' }, 'amount'],
      [{ ...CHECK, date: 'March-ish' }, 'cheque date'],
      [{ ...CHECK, createdAt: undefined }, 'createdAt'],
    ]
    for (const [input, reasonIncludes] of cases) {
      const result = mapLegacyCheque(input, context)
      expect(result.ok, JSON.stringify(input)).toBe(false)
      if (result.ok) continue
      expect(result.failure.kind).toBe('cheque')
      expect(result.failure.reason).toContain(reasonIncludes)
    }
  })
})

describe('matchLegacyAccountForCheck', () => {
  const otherAccount: LegacyBankAccountShape = { ...ACCOUNT, id: 'legacy-acc-2', name: 'Other Bank' }

  it('matches on exact account number AND bank name', () => {
    const result = matchLegacyAccountForCheck(CHECK, [otherAccount, ACCOUNT])
    expect(result.kind).toBe('unique')
    expect(result.legacyAccount?.id).toBe('legacy-acc-1')
  })

  it('distinguishes account numbers that differ only by leading zeros', () => {
    const withoutZeros: LegacyBankAccountShape = { ...ACCOUNT, id: 'legacy-acc-zeros', accountNumber: '12345' }
    const result = matchLegacyAccountForCheck(CHECK, [withoutZeros])
    expect(result.kind).toBe('none')
  })

  it('reports no match instead of attaching to the wrong account', () => {
    const result = matchLegacyAccountForCheck({ ...CHECK, bankName: 'Unknown Bank' }, [ACCOUNT])
    expect(result.kind).toBe('none')
    expect(result.legacyAccount).toBeNull()
  })

  it('breaks ambiguity deterministically (lexicographic legacy id)', () => {
    const dupe: LegacyBankAccountShape = { ...ACCOUNT, id: 'legacy-acc-0' }
    const result = matchLegacyAccountForCheck(CHECK, [ACCOUNT, dupe])
    expect(result.kind).toBe('ambiguous')
    expect(result.legacyAccount?.id).toBe('legacy-acc-0')
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(['legacy-acc-0', 'legacy-acc-1'])
  })
})

describe('toIsoTimestamp', () => {
  it('normalises Dates and preserves valid ISO strings verbatim', () => {
    expect(toIsoTimestamp(new Date(Date.UTC(2026, 0, 5, 8)))).toBe('2026-01-05T08:00:00.000Z')
    expect(toIsoTimestamp('2026-01-05T08:00:00.000Z')).toBe('2026-01-05T08:00:00.000Z')
    expect(toIsoTimestamp('not a date')).toBeNull()
    expect(toIsoTimestamp(undefined)).toBeNull()
  })

  it('normaliseBankName refuses non-strings', () => {
    expect(normaliseBankName('First National')).toBe('first national')
    expect(normaliseBankName(42)).toBeNull()
    expect(normaliseBankName('   ')).toBeNull()
  })
})
