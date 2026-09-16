import { describe, expect, it } from 'vitest'
import { ChequeBookSequence } from '../sequence/ChequeBookSequence'
import { decomposeSequence, formatChequeNumber } from '../sequence/ChequeBookSequence'
import { ChequeBookExhaustedError, InvalidChequeBookSequenceError } from '../errors'

/**
 * Sequence engine coverage.
 *
 * Maps to the required test list items 2–6, 8 and 9:
 *   2. 4567 -> 4568            3. A4567 -> A4568         4. A0001 -> A0002
 *   5. leading-zero handling   6. prefix handling        8. invalid sequences rejected
 *   9. end sequence enforced
 */
describe('ChequeBookSequence', () => {
  describe('numeric progression', () => {
    it('advances 4567 -> 4568 (required case 2)', () => {
      const sequence = ChequeBookSequence.create({
        sequenceMode: 'numeric',
        startSequence: 4567,
      })

      expect(sequence.peekNextChequeNumber().value).toBe('4567')

      const first = sequence.allocate('book-1')
      expect(first.chequeNumber.value).toBe('4567')
      expect(first.sequence.currentSequence).toBe(4568)

      const second = first.sequence.allocate('book-1')
      expect(second.chequeNumber.value).toBe('4568')
      expect(second.sequence.currentSequence).toBe(4569)
    })

    it('advances across a decade and century boundary without special-casing', () => {
      let sequence = ChequeBookSequence.create({ startSequence: 98, endSequence: 102 })
      const produced: string[] = []
      while (!sequence.isExhausted) {
        const next = sequence.allocate('book-1')
        produced.push(next.chequeNumber.value)
        sequence = next.sequence
      }
      expect(produced).toEqual(['98', '99', '100', '101', '102'])
    })

    it('starts at 1 by default', () => {
      const sequence = ChequeBookSequence.create()
      expect(sequence.currentSequence).toBe(1)
      expect(sequence.formatNumber(sequence.currentSequence).value).toBe('1')
    })
  })

  describe('alphanumeric progression', () => {
    it('advances A4567 -> A4568 (required case 3)', () => {
      const sequence = ChequeBookSequence.create({
        sequenceMode: 'alphanumeric',
        prefix: 'A',
        startSequence: 4567,
      })

      const first = sequence.allocate('book-1')
      expect(first.chequeNumber.value).toBe('A4567')

      const second = first.sequence.allocate('book-1')
      expect(second.chequeNumber.value).toBe('A4568')
    })

    it('advances A0001 -> A0002 with zero padding (required case 4)', () => {
      const sequence = ChequeBookSequence.create({
        sequenceMode: 'alphanumeric',
        prefix: 'A',
        startSequence: 1,
        sequenceWidth: 4,
      })

      const first = sequence.allocate('book-1')
      expect(first.chequeNumber.value).toBe('A0001')

      const second = first.sequence.allocate('book-1')
      expect(second.chequeNumber.value).toBe('A0002')
    })

    it('supports multi-character prefixes without padding the prefix', () => {
      const sequence = ChequeBookSequence.create({
        sequenceMode: 'alphanumeric',
        prefix: 'NBE',
        startSequence: 7,
        sequenceWidth: 3,
      })
      expect(sequence.peekNextChequeNumber().value).toBe('NBE007')
    })
  })

  describe('leading-zero preservation (required case 5)', () => {
    it('pads a numeric sequence to the configured width', () => {
      const sequence = ChequeBookSequence.create({ startSequence: 1, sequenceWidth: 4 })
      expect(sequence.peekNextChequeNumber().value).toBe('0001')
      expect(sequence.allocate('b').sequence.peekNextChequeNumber().value).toBe('0002')
    })

    it('preserves leading zeros through a long run', () => {
      let sequence = ChequeBookSequence.create({ startSequence: 1, sequenceWidth: 6 })
      const produced: string[] = []
      for (let i = 0; i < 12; i += 1) {
        const next = sequence.allocate('b')
        produced.push(next.chequeNumber.value)
        sequence = next.sequence
      }
      expect(produced[0]).toBe('000001')
      expect(produced[9]).toBe('000010')
      expect(produced[11]).toBe('000012')
      expect(produced.every((n) => n.length === 6)).toBe(true)
    })

    it('never truncates when the value outgrows the width', () => {
      const sequence = ChequeBookSequence.create({ startSequence: 12345, sequenceWidth: 4 })
      expect(sequence.peekNextChequeNumber().value).toBe('12345')
    })

    it('keeps 0001 and 1 as distinct numbers', () => {
      const padded = ChequeBookSequence.create({ startSequence: 1, sequenceWidth: 4 })
      const plain = ChequeBookSequence.create({ startSequence: 1 })
      expect(padded.peekNextChequeNumber().value).not.toBe(plain.peekNextChequeNumber().value)
    })
  })

  describe('prefix handling (required case 6)', () => {
    it('applies the prefix to every generated number', () => {
      let sequence = ChequeBookSequence.create({
        sequenceMode: 'alphanumeric',
        prefix: 'X',
        startSequence: 10,
        endSequence: 12,
      })
      const produced: string[] = []
      while (!sequence.isExhausted) {
        const next = sequence.allocate('b')
        produced.push(next.chequeNumber.value)
        sequence = next.sequence
      }
      expect(produced).toEqual(['X10', 'X11', 'X12'])
      expect(produced.every((n) => n.startsWith('X'))).toBe(true)
    })

    it('rejects a prefix on a numeric-mode book', () => {
      expect(() =>
        ChequeBookSequence.create({ sequenceMode: 'numeric', prefix: 'A' })
      ).toThrow(InvalidChequeBookSequenceError)
    })

    it('rejects alphanumeric mode with no prefix', () => {
      expect(() => ChequeBookSequence.create({ sequenceMode: 'alphanumeric' })).toThrow(
        InvalidChequeBookSequenceError
      )
    })

    it('rejects a prefix containing whitespace', () => {
      expect(() =>
        ChequeBookSequence.create({ sequenceMode: 'alphanumeric', prefix: 'A B' })
      ).toThrow(InvalidChequeBookSequenceError)
    })
  })

  describe('invalid sequences rejected (required case 8)', () => {
    it('rejects endSequence below startSequence', () => {
      expect(() =>
        ChequeBookSequence.create({ startSequence: 100, endSequence: 50 })
      ).toThrow(/endSequence \(50\) must be >= startSequence \(100\)/)
    })

    it('rejects currentSequence before startSequence — the cursor never moves backwards', () => {
      expect(() =>
        ChequeBookSequence.create({ startSequence: 100, currentSequence: 99 })
      ).toThrow(/can never move backwards/)
    })

    it('rejects a negative startSequence', () => {
      expect(() => ChequeBookSequence.create({ startSequence: -1 })).toThrow(
        InvalidChequeBookSequenceError
      )
    })

    it.each([
      ['a float', 1.5],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['beyond the safe integer range', Number.MAX_SAFE_INTEGER + 1],
    ])('rejects %s for startSequence', (_label, value) => {
      expect(() => ChequeBookSequence.create({ startSequence: value })).toThrow(
        /must be a safe integer/
      )
    })

    it('rejects a non-integer sequenceWidth', () => {
      expect(() => ChequeBookSequence.create({ sequenceWidth: 3.5 })).toThrow(
        /must be a safe integer/
      )
    })

    it('rejects a zero or negative sequenceWidth', () => {
      expect(() => ChequeBookSequence.create({ sequenceWidth: 0 })).toThrow(
        InvalidChequeBookSequenceError
      )
      expect(() => ChequeBookSequence.create({ sequenceWidth: -2 })).toThrow(
        InvalidChequeBookSequenceError
      )
    })

    it('rejects an unknown sequenceMode', () => {
      expect(() =>
        ChequeBookSequence.create({ sequenceMode: 'auto' as never })
      ).toThrow(/sequenceMode must be one of/)
    })

    it('rejects formatting a non-integer sequence', () => {
      const sequence = ChequeBookSequence.create({ startSequence: 1 })
      expect(() => sequence.formatNumber(1.5)).toThrow(/must be a safe integer/)
      expect(() => sequence.formatNumber(-1)).toThrow(/must be >= 0/)
    })
  })

  describe('end sequence enforcement (required case 9)', () => {
    it('allocates the endSequence value itself, then reports exhaustion', () => {
      const sequence = ChequeBookSequence.create({ startSequence: 1, endSequence: 3 })

      expect(sequence.remaining).toBe(3)
      const first = sequence.allocate('b')
      expect(first.sequence.remaining).toBe(2)
      const second = first.sequence.allocate('b')
      const third = second.sequence.allocate('b')

      expect(third.chequeNumber.value).toBe('3')
      expect(third.sequence.isExhausted).toBe(true)
      expect(third.sequence.remaining).toBe(0)
    })

    it('throws ChequeBookExhaustedError once the book is spent', () => {
      const sequence = ChequeBookSequence.create({ startSequence: 1, endSequence: 1 })
      const spent = sequence.allocate('book-42').sequence

      expect(() => spent.allocate('book-42')).toThrow(ChequeBookExhaustedError)
      expect(() => spent.peekNextChequeNumber()).toThrow(ChequeBookExhaustedError)

      try {
        spent.allocate('book-42')
      } catch (error) {
        expect(error).toBeInstanceOf(ChequeBookExhaustedError)
        expect((error as ChequeBookExhaustedError).code).toBe('CHEQUE_BOOK_EXHAUSTED')
        expect((error as ChequeBookExhaustedError).chequeBookId).toBe('book-42')
        expect((error as ChequeBookExhaustedError).endSequence).toBe(1)
      }
    })

    it('treats a single-number book as immediately exhausted after one allocation', () => {
      const sequence = ChequeBookSequence.create({ startSequence: 500, endSequence: 500 })
      expect(sequence.remaining).toBe(1)
      const allocated = sequence.allocate('b')
      expect(allocated.chequeNumber.value).toBe('500')
      expect(allocated.sequence.remaining).toBe(0)
      expect(allocated.sequence.isExhausted).toBe(true)
    })

    it('reports null remaining for an open-ended book', () => {
      const sequence = ChequeBookSequence.create({ startSequence: 1 })
      expect(sequence.endSequence).toBeNull()
      expect(sequence.remaining).toBeNull()
      expect(sequence.isExhausted).toBe(false)
    })

    it('never wraps around to the start after exhaustion', () => {
      const sequence = ChequeBookSequence.create({ startSequence: 1, endSequence: 2 })
      const spent = sequence.allocate('b').sequence.allocate('b').sequence
      expect(spent.currentSequence).toBe(3)
      expect(() => spent.allocate('b')).toThrow(ChequeBookExhaustedError)
      // The cursor stayed past the end rather than resetting to 1.
      expect(spent.currentSequence).toBe(3)
    })
  })

  describe('immutability and determinism', () => {
    it('never mutates the receiver', () => {
      const sequence = ChequeBookSequence.create({ startSequence: 4567 })
      const before = sequence.currentSequence

      sequence.allocate('b')

      expect(sequence.currentSequence).toBe(before)
      expect(sequence.peekNextChequeNumber().value).toBe('4567')
    })

    it('is deterministic: identical inputs produce identical number sequences', () => {
      const run = (): string[] => {
        let s = ChequeBookSequence.create({
          sequenceMode: 'alphanumeric',
          prefix: 'A',
          startSequence: 1,
          sequenceWidth: 4,
          endSequence: 5,
        })
        const out: string[] = []
        while (!s.isExhausted) {
          const next = s.allocate('b')
          out.push(next.chequeNumber.value)
          s = next.sequence
        }
        return out
      }

      expect(run()).toEqual(run())
      expect(run()).toEqual(['A0001', 'A0002', 'A0003', 'A0004', 'A0005'])
    })

    it('round-trips through JSON state without losing configuration', () => {
      const sequence = ChequeBookSequence.create({
        sequenceMode: 'alphanumeric',
        prefix: 'A',
        startSequence: 1,
        currentSequence: 3,
        endSequence: 10,
        sequenceWidth: 4,
      })

      const restored = ChequeBookSequence.fromJSON(JSON.parse(JSON.stringify(sequence.toJSON())))

      expect(restored.toState()).toEqual(sequence.toState())
      expect(restored.peekNextChequeNumber().value).toBe('A0003')
    })
  })

  describe('manual mode', () => {
    it('refuses to allocate or peek', () => {
      const sequence = ChequeBookSequence.create({ sequenceMode: 'manual', prefix: 'A' })

      expect(sequence.isManual).toBe(true)
      expect(sequence.isAutomatic).toBe(false)
      expect(() => sequence.allocate('b')).toThrow(InvalidChequeBookSequenceError)
      expect(() => sequence.peekNextChequeNumber()).toThrow(InvalidChequeBookSequenceError)
    })

    it('is never reported exhausted — it has no cursor to spend', () => {
      const sequence = ChequeBookSequence.create({ sequenceMode: 'manual' })
      expect(sequence.isExhausted).toBe(false)
      expect(sequence.remaining).toBeNull()
    })

    it('validates a supplied number verbatim without parsing it', () => {
      const sequence = ChequeBookSequence.create({ sequenceMode: 'manual', prefix: 'A' })
      expect(sequence.validateManualChequeNumber('A9999').value).toBe('A9999')
      expect(sequence.validateManualChequeNumber('A0001').value).toBe('A0001')
    })

    it('rejects a supplied number that does not carry the configured prefix', () => {
      const sequence = ChequeBookSequence.create({ sequenceMode: 'manual', prefix: 'A' })
      expect(() => sequence.validateManualChequeNumber('B0001')).toThrow(/does not start with/)
    })

    it('rejects a manual number on an automatic book', () => {
      const sequence = ChequeBookSequence.create({ startSequence: 1 })
      expect(() => sequence.validateManualChequeNumber('1')).toThrow(
        /may only be supplied for a "manual" book/
      )
    })
  })

  describe('standalone helpers', () => {
    it('formatChequeNumber mirrors the engine', () => {
      expect(formatChequeNumber('', 4567)).toBe('4567')
      expect(formatChequeNumber('A', 4567)).toBe('A4567')
      expect(formatChequeNumber('A', 1, 4)).toBe('A0001')
      expect(formatChequeNumber('', 1, 4)).toBe('0001')
    })

    it('decomposeSequence reads only the digits AFTER a known prefix', () => {
      expect(decomposeSequence('A4567', 'A')).toBe(4567)
      expect(decomposeSequence('A0001', 'A')).toBe(1)
      expect(decomposeSequence('0001', '')).toBe(1)
    })

    it('decomposeSequence refuses ambiguity rather than guessing', () => {
      expect(decomposeSequence('B4567', 'A')).toBeNull()
      expect(decomposeSequence('A45X7', 'A')).toBeNull()
      expect(decomposeSequence('A', 'A')).toBeNull()
      expect(decomposeSequence('99999999999999999999', '')).toBeNull()
    })

    it('decomposeSequence never interprets the complete number as a value', () => {
      // "A4567" as a whole is not numeric; only the post-prefix digits are read.
      expect(Number.isNaN(Number('A4567'))).toBe(true)
      expect(decomposeSequence('A4567', 'A')).toBe(4567)
    })
  })
})
