import { describe, expect, it } from 'vitest'
import { Money } from '../value-objects/Money'
import { DefaultCurrencyRegistry } from '../value-objects/CurrencyRegistry'
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  UnknownCurrencyError,
} from '../errors'

/**
 * Money coverage — required test list item 15: amounts must not suffer
 * floating-point corruption.
 *
 * Every assertion here compares against the exact decimal string, never against a
 * binary double, because the whole point is that `0.1 + 0.2 !== 0.3` in JS floats.
 */
describe('Money', () => {
  describe('exact construction', () => {
    it('stores an integer count of minor units', () => {
      const amount = Money.fromDecimalString('1234.56', 'EGP')
      expect(amount.minorUnits).toBe(123456)
      expect(amount.currency).toBe('EGP')
      expect(Number.isInteger(amount.minorUnits)).toBe(true)
    })

    it('round-trips through toDecimalString without drift', () => {
      for (const value of ['0.00', '0.01', '0.10', '1.00', '1.005', '99999.99', '0.07']) {
        const amount = Money.fromDecimalString(value, 'EGP')
        expect(amount.toDecimalString()).toBe(value === '1.005' ? '1.01' : value)
      }
    })

    it('handles amounts with no fractional part', () => {
      expect(Money.fromDecimalString('500', 'EGP').toDecimalString()).toBe('500.00')
      expect(Money.fromDecimalString('500', 'EGP').minorUnits).toBe(50000)
    })

    it('handles negative amounts', () => {
      const amount = Money.fromDecimalString('-25.50', 'EGP')
      expect(amount.minorUnits).toBe(-2550)
      expect(amount.toDecimalString()).toBe('-25.50')
      expect(amount.isNegative()).toBe(true)
    })

    it('accepts an explicit plus sign', () => {
      expect(Money.fromDecimalString('+12.34', 'EGP').minorUnits).toBe(1234)
    })

    it('constructs directly from minor units', () => {
      expect(Money.fromMinorUnits(123456, 'EGP').toDecimalString()).toBe('1234.56')
    })
  })

  describe('no floating-point corruption (required case 15)', () => {
    it('adds 0.1 + 0.2 to exactly 0.3', () => {
      const sum = Money.fromDecimalString('0.1', 'EGP').add(Money.fromDecimalString('0.2', 'EGP'))

      // The classic float failure: 0.1 + 0.2 === 0.30000000000000004
      expect(0.1 + 0.2).not.toBe(0.3)
      expect(sum.toDecimalString()).toBe('0.30')
      expect(sum.minorUnits).toBe(30)
    })

    it('sums a long column of awkward decimals exactly', () => {
      const values = Array.from({ length: 10 }, () => Money.fromDecimalString('0.01', 'EGP'))
      const total = Money.sum(values, 'EGP')
      expect(total.toDecimalString()).toBe('0.10')
      expect(total.minorUnits).toBe(10)
    })

    it('sums 1000 x 0.07 to exactly 70.00', () => {
      const values = Array.from({ length: 1000 }, () => Money.fromDecimalString('0.07', 'EGP'))
      expect(Money.sum(values, 'EGP').toDecimalString()).toBe('70.00')
      // A float accumulator would drift here.
      expect(values.reduce((acc, v) => acc + Number(v.toDecimalString()), 0)).not.toBe(70)
    })

    it('multiplies by an integer exactly', () => {
      const amount = Money.fromDecimalString('19.99', 'EGP')
      expect(amount.multiplyByInteger(3).toDecimalString()).toBe('59.97')
      expect(amount.multiplyByInteger(0).isZero()).toBe(true)
      expect(amount.multiplyByInteger(-2).toDecimalString()).toBe('-39.98')
    })

    it('subtracts to exactly zero', () => {
      const a = Money.fromDecimalString('100.10', 'EGP')
      const b = Money.fromDecimalString('100.10', 'EGP')
      const difference = a.subtract(b)
      expect(difference.isZero()).toBe(true)
      expect(difference.toDecimalString()).toBe('0.00')
    })

    it('preserves a large ledger total exactly', () => {
      const values = [
        '1234567.89',
        '0.01',
        '999999.99',
        '1.10',
        '2.20',
        '3.30',
      ].map((v) => Money.fromDecimalString(v, 'EGP'))

      expect(Money.sum(values, 'EGP').toDecimalString()).toBe('2234574.49')
    })

    it('refuses a fractional multiplication factor instead of rounding silently', () => {
      const amount = Money.fromDecimalString('10.00', 'EGP')
      expect(() => amount.multiplyByInteger(1.5)).toThrow(/safe integer/)
    })

    it('never exposes a float in its serialised form', () => {
      const json = Money.fromDecimalString('1234.56', 'EGP').toJSON()
      expect(json).toEqual({ minorUnits: 123456, currency: 'EGP' })
      expect(Number.isInteger(json.minorUnits)).toBe(true)
      expect(JSON.stringify(json)).not.toContain('.')
    })
  })

  describe('rejects imprecise input', () => {
    it('refuses a binary number as an amount source', () => {
      // There is deliberately no fromNumber(): a double may already be imprecise.
      expect((Money as unknown as { fromNumber?: unknown }).fromNumber).toBeUndefined()
      expect(() => Money.fromDecimalString(1.005 as never, 'EGP')).toThrow(
        /expected a decimal string/
      )
    })

    it('refuses a float passed as minorUnits', () => {
      expect(() => Money.fromMinorUnits(1234.56, 'EGP')).toThrow(/safe integer/)
      expect(() => Money.fromMinorUnits(Number.NaN, 'EGP')).toThrow(/safe integer/)
    })

    it.each(['', 'abc', '1,234.56', '12.34.56', 'EGP 12', '1e3', '0x10', '--5', '.5', '5.'])(
      'refuses the malformed decimal string %j',
      (input) => {
        expect(() => Money.fromDecimalString(input, 'EGP')).toThrow(InvalidMoneyError)
      }
    )
  })

  describe('rounding of over-precise input', () => {
    it('rounds half-up by default', () => {
      expect(Money.fromDecimalString('1.005', 'EGP').toDecimalString()).toBe('1.01')
      expect(Money.fromDecimalString('1.004', 'EGP').toDecimalString()).toBe('1.00')
    })

    it('truncates with the "down" policy', () => {
      expect(Money.fromDecimalString('1.009', 'EGP', { rounding: 'down' }).toDecimalString()).toBe(
        '1.00'
      )
    })

    it('rounds away from zero with the "up" policy', () => {
      expect(Money.fromDecimalString('1.001', 'EGP', { rounding: 'up' }).toDecimalString()).toBe(
        '1.01'
      )
    })

    it('rounds half to even with the "half-even" policy', () => {
      expect(
        Money.fromDecimalString('1.005', 'EGP', { rounding: 'half-even' }).toDecimalString()
      ).toBe('1.00')
      expect(
        Money.fromDecimalString('1.015', 'EGP', { rounding: 'half-even' }).toDecimalString()
      ).toBe('1.02')
    })

    it('rejects over-precise input with the "reject" policy', () => {
      expect(() => Money.fromDecimalString('1.005', 'EGP', { rounding: 'reject' })).toThrow(
        /more precision than the currency supports/
      )
    })

    it('does not round when the input already fits the currency', () => {
      expect(Money.fromDecimalString('1.00', 'EGP', { rounding: 'reject' }).toDecimalString()).toBe(
        '1.00'
      )
    })
  })

  describe('currency awareness (currency is not hardcoded)', () => {
    it('uses 2 minor digits for EGP and USD', () => {
      expect(Money.fromDecimalString('10.5', 'EGP').minorUnits).toBe(1050)
      expect(Money.fromDecimalString('10.5', 'USD').minorUnits).toBe(1050)
    })

    it('uses 0 minor digits for JPY', () => {
      const amount = Money.fromDecimalString('1050', 'JPY')
      expect(amount.minorUnits).toBe(1050)
      expect(amount.toDecimalString()).toBe('1050')
    })

    it('uses 3 minor digits for KWD and BHD', () => {
      expect(Money.fromDecimalString('1.250', 'KWD').minorUnits).toBe(1250)
      expect(Money.fromDecimalString('1.250', 'BHD').toDecimalString()).toBe('1.250')
    })

    it('normalises the currency code case', () => {
      expect(Money.fromDecimalString('1.00', 'egp').currency).toBe('EGP')
      expect(Money.fromDecimalString('1.00', ' EGP ').currency).toBe('EGP')
    })

    it('accepts a registered custom currency', () => {
      const registry = new DefaultCurrencyRegistry()
      registry.register('XYZ', 4)
      const amount = Money.fromDecimalString('1.2345', 'XYZ', { registry })
      expect(amount.minorUnits).toBe(12345)
      expect(amount.toDecimalString(registry)).toBe('1.2345')
    })

    it('accepts an explicit minorDigits override without a registry', () => {
      const amount = Money.fromDecimalString('1.234', 'AAA', { minorDigits: 3 })
      expect(amount.minorUnits).toBe(1234)
    })

    it('throws for an unregistered currency when the fallback is disabled', () => {
      const strict = new DefaultCurrencyRegistry({ fallbackMinorDigits: null })
      expect(() => strict.minorDigitsOf('QQQ')).toThrow(UnknownCurrencyError)
      expect(() => Money.fromDecimalString('1.00', 'QQQ', { registry: strict })).toThrow(
        UnknownCurrencyError
      )
    })

    it('rejects a malformed currency code', () => {
      expect(() => Money.fromDecimalString('1.00', 'EG')).toThrow(UnknownCurrencyError)
      expect(() => Money.fromDecimalString('1.00', 'EGPP')).toThrow(UnknownCurrencyError)
      expect(() => Money.fromDecimalString('1.00', '')).toThrow(UnknownCurrencyError)
    })

    it('refuses to combine different currencies', () => {
      const egp = Money.fromDecimalString('10.00', 'EGP')
      const usd = Money.fromDecimalString('10.00', 'USD')

      expect(() => egp.add(usd)).toThrow(CurrencyMismatchError)
      expect(() => egp.subtract(usd)).toThrow(CurrencyMismatchError)
      expect(() => egp.compareTo(usd)).toThrow(CurrencyMismatchError)
      expect(() => Money.sum([egp, usd], 'EGP')).toThrow(CurrencyMismatchError)
    })
  })

  describe('comparison and equality', () => {
    it('compares by exact value', () => {
      const small = Money.fromDecimalString('9.99', 'EGP')
      const large = Money.fromDecimalString('10.00', 'EGP')

      expect(small.isLessThan(large)).toBe(true)
      expect(large.isGreaterThan(small)).toBe(true)
      expect(small.compareTo(large)).toBe(-1)
      expect(large.compareTo(small)).toBe(1)
    })

    it('does not treat 10.00 and 10.0 as different values', () => {
      expect(Money.fromDecimalString('10.00', 'EGP').equals(Money.fromDecimalString('10.0', 'EGP'))).toBe(
        true
      )
    })

    it('requires the same currency for equality', () => {
      expect(Money.fromDecimalString('10.00', 'EGP').equals(Money.fromDecimalString('10.00', 'USD'))).toBe(
        false
      )
    })

    it('reports sign and zero predicates', () => {
      expect(Money.zero('EGP').isZero()).toBe(true)
      expect(Money.fromDecimalString('0.01', 'EGP').isPositive()).toBe(true)
      expect(Money.fromDecimalString('-0.01', 'EGP').isNegative()).toBe(true)
      expect(Money.fromDecimalString('-0.01', 'EGP').abs().toDecimalString()).toBe('0.01')
      expect(Money.fromDecimalString('0.01', 'EGP').negate().toDecimalString()).toBe('-0.01')
    })
  })

  describe('serialisation', () => {
    it('round-trips through JSON', () => {
      const original = Money.fromDecimalString('1234.56', 'EGP')
      const restored = Money.fromJSON(JSON.parse(JSON.stringify(original)))
      expect(restored.equals(original)).toBe(true)
      expect(restored.toDecimalString()).toBe('1234.56')
    })

    it('rejects malformed JSON', () => {
      expect(() => Money.fromJSON(null as never)).toThrow(InvalidMoneyError)
      expect(() => Money.fromJSON({ minorUnits: 1.5, currency: 'EGP' })).toThrow(InvalidMoneyError)
    })

    it('renders a human-readable string', () => {
      expect(Money.fromDecimalString('1234.56', 'EGP').toString()).toBe('1234.56 EGP')
    })
  })
})
