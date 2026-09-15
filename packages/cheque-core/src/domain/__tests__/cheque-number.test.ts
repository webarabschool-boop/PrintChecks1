import { describe, expect, it } from 'vitest'
import { ChequeNumber } from '../value-objects/ChequeNumber'
import { InvalidChequeNumberError } from '../errors'

/**
 * The cheque number is a STRING. These tests pin that contract down, including the
 * requirement that the complete number is never numerically parsed.
 */
describe('ChequeNumber', () => {
  describe('preserves the exact string', () => {
    it.each([
      '4567',
      'A4567',
      'A0001',
      '0001',
      '0000001',
      '00123',
      'NBE-0042',
      'X9Z8',
      'a4567',
    ])('stores %j verbatim', (value) => {
      expect(ChequeNumber.of(value).value).toBe(value)
      expect(ChequeNumber.of(value).toString()).toBe(value)
    })

    it('preserves leading zeros that a numeric field would destroy', () => {
      const number = ChequeNumber.of('00123')
      expect(number.value).toBe('00123')
      expect(number.value.length).toBe(5)
      // What a numeric model would have produced:
      expect(String(Number('00123'))).toBe('123')
      expect(number.value).not.toBe(String(Number('00123')))
    })

    it('preserves lowercase prefixes exactly, without case folding', () => {
      expect(ChequeNumber.of('a4567').value).toBe('a4567')
      expect(ChequeNumber.of('a4567').equals(ChequeNumber.of('A4567'))).toBe(false)
    })

    it('serialises as the bare string', () => {
      expect(ChequeNumber.of('A0001').toJSON()).toBe('A0001')
      expect(JSON.stringify({ n: ChequeNumber.of('A0001') })).toBe('{"n":"A0001"}')
    })
  })

  describe('is never numerically parsed', () => {
    it('exposes no numeric coercion of the complete value', () => {
      const number = ChequeNumber.of('A4567')
      // The value object offers no numeric projection of the whole string.
      const own = Object.getOwnPropertyNames(Object.getPrototypeOf(number))
      expect(own).not.toContain('toNumber')
      expect(own).not.toContain('asNumber')
      expect(own).not.toContain('numericValue')
    })

    it('accepts values that have no numeric meaning at all', () => {
      expect(() => ChequeNumber.of('ZZ-VOID-99')).not.toThrow()
      expect(Number.isNaN(Number('ZZ-VOID-99'))).toBe(true)
      expect(ChequeNumber.of('ZZ-VOID-99').value).toBe('ZZ-VOID-99')
    })

    it('reports numeric-only as information without changing the value', () => {
      expect(ChequeNumber.of('4567').isNumericOnly()).toBe(true)
      expect(ChequeNumber.of('A4567').isNumericOnly()).toBe(false)
      expect(ChequeNumber.of('0001').isNumericOnly()).toBe(true)
      // Still the exact string either way:
      expect(ChequeNumber.of('0001').value).toBe('0001')
    })

    it('rejects a number passed where a string is required', () => {
      expect(() => ChequeNumber.of(4567)).toThrow(InvalidChequeNumberError)
      expect(() => ChequeNumber.of(4567)).toThrow(/must never be modelled as a numeric value/)
    })

    it('treats numerically-equal but textually-different numbers as distinct', () => {
      const a = ChequeNumber.of('0001')
      const b = ChequeNumber.of('1')
      expect(a.equals(b)).toBe(false)
      expect(Number(a.value)).toBe(Number(b.value))
    })
  })

  describe('validation', () => {
    it('rejects empty and whitespace-only values', () => {
      expect(() => ChequeNumber.of('')).toThrow(InvalidChequeNumberError)
      expect(() => ChequeNumber.of('   ')).toThrow(/leading or trailing whitespace/)
    })

    it('rejects leading or trailing whitespace rather than silently trimming', () => {
      // Silently trimming would change the number that gets printed and audited.
      expect(() => ChequeNumber.of(' 4567')).toThrow(/leading or trailing whitespace/)
      expect(() => ChequeNumber.of('4567 ')).toThrow(/leading or trailing whitespace/)
    })

    it('rejects interior whitespace', () => {
      expect(() => ChequeNumber.of('A 4567')).toThrow(/must not contain whitespace/)
    })

    it('rejects control characters', () => {
      expect(() => ChequeNumber.of('45\n67')).toThrow(/control characters/)
      expect(() => ChequeNumber.of('45\x0067')).toThrow(/control characters/)
    })

    it('rejects values beyond the maximum length', () => {
      const tooLong = '9'.repeat(ChequeNumber.MAX_LENGTH + 1)
      expect(() => ChequeNumber.of(tooLong)).toThrow(/exceeds maximum length/)
      expect(() => ChequeNumber.of('9'.repeat(ChequeNumber.MAX_LENGTH))).not.toThrow()
    })

    it('rejects non-string types', () => {
      expect(() => ChequeNumber.of(null)).toThrow(/expected a string, received null/)
      expect(() => ChequeNumber.of(undefined)).toThrow(/expected a string, received undefined/)
      expect(() => ChequeNumber.of({})).toThrow(/expected a string, received object/)
      expect(() => ChequeNumber.of(['4567'])).toThrow(/expected a string, received object/)
    })
  })

  describe('comparison', () => {
    it('compares exactly and case-sensitively', () => {
      expect(ChequeNumber.of('4567').equals(ChequeNumber.of('4567'))).toBe(true)
      expect(ChequeNumber.of('4567').equals(ChequeNumber.of('4568'))).toBe(false)
      expect(ChequeNumber.of('4567').equals(null)).toBe(false)
      expect(ChequeNumber.of('4567').equals(undefined)).toBe(false)
    })

    it('orders lexicographically, never numerically', () => {
      // Numeric ordering would put 9 after 10; string ordering must not.
      expect(ChequeNumber.of('9').compareTo(ChequeNumber.of('10'))).toBe(1)
      expect(ChequeNumber.of('A0001').compareTo(ChequeNumber.of('A0002'))).toBe(-1)
      expect(ChequeNumber.of('A0002').compareTo(ChequeNumber.of('A0002'))).toBe(0)
    })
  })

  describe('round-trip', () => {
    it('rebuilds from JSON', () => {
      const original = ChequeNumber.of('A0001')
      expect(ChequeNumber.fromJSON(JSON.parse(JSON.stringify(original))).equals(original)).toBe(true)
    })
  })
})
