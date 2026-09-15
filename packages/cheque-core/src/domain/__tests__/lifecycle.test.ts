import { describe, expect, it } from 'vitest'
import { Cheque } from '../entities/Cheque'
import { Money } from '../value-objects/Money'
import {
  CHEQUE_STATUS_TRANSITIONS,
  CHEQUE_STATUSES,
  allowedTransitions,
  appendStatusEntry,
  assertTransition,
  canTransition,
  isChequeStatus,
  isTerminalStatus,
  statusFromHistory,
} from '../lifecycle/ChequeStatus'
import { InvalidChequeStatusTransitionError } from '../errors'

const NOW = '2026-01-15T10:00:00.000Z'
const LATER = '2026-01-16T10:00:00.000Z'

function makeCheque(initialStatus: 'draft' | 'issued' = 'draft') {
  return Cheque.create({
    id: 'chq_1',
    chequeBookId: 'cbk_1',
    chequeNumber: '4567',
    amount: Money.fromDecimalString('250.00', 'EGP'),
    payeeName: 'Supplier Co',
    initialStatus,
    createdAt: NOW,
  })
}

describe('cheque lifecycle', () => {
  describe('the status vocabulary', () => {
    it('covers exactly the required states', () => {
      expect([...CHEQUE_STATUSES].sort()).toEqual(
        ['cancelled', 'cleared', 'draft', 'issued', 'presented', 'printed', 'returned'].sort()
      )
    })

    it('has a transition row for every status', () => {
      for (const status of CHEQUE_STATUSES) {
        expect(CHEQUE_STATUS_TRANSITIONS[status]).toBeDefined()
        expect(Array.isArray(CHEQUE_STATUS_TRANSITIONS[status])).toBe(true)
      }
    })

    it('only ever transitions to a known status', () => {
      for (const targets of Object.values(CHEQUE_STATUS_TRANSITIONS)) {
        for (const target of targets) {
          expect(isChequeStatus(target)).toBe(true)
        }
      }
    })

    it('marks cancelled and returned as terminal', () => {
      expect(isTerminalStatus('cancelled')).toBe(true)
      expect(isTerminalStatus('returned')).toBe(true)
      expect(isTerminalStatus('cleared')).toBe(false)
      expect(isTerminalStatus('draft')).toBe(false)
    })

    it('validates unknown status strings', () => {
      expect(isChequeStatus('issued')).toBe(true)
      expect(isChequeStatus('voided')).toBe(false)
      expect(isChequeStatus(42)).toBe(false)
      expect(isChequeStatus(null)).toBe(false)
    })
  })

  describe('legal transitions', () => {
    const legalPaths: Array<[string, string]> = [
      ['draft', 'issued'],
      ['draft', 'cancelled'],
      ['issued', 'printed'],
      ['issued', 'cancelled'],
      ['printed', 'presented'],
      ['printed', 'cancelled'],
      ['printed', 'returned'],
      ['presented', 'cleared'],
      ['presented', 'returned'],
      ['presented', 'cancelled'],
      ['cleared', 'returned'],
    ]

    it.each(legalPaths)('allows %s -> %s', (from, to) => {
      expect(canTransition(from as never, to as never)).toBe(true)
      expect(() => assertTransition(from as never, to as never)).not.toThrow()
    })

    it('allows a full happy path draft -> issued -> printed -> presented -> cleared', () => {
      let cheque = makeCheque()
      expect(cheque.status).toBe('draft')

      cheque = cheque.transitionTo('issued', { occurredAt: NOW })
      cheque = cheque.transitionTo('printed', { occurredAt: NOW })
      cheque = cheque.transitionTo('presented', { occurredAt: LATER })
      cheque = cheque.transitionTo('cleared', { occurredAt: LATER })

      expect(cheque.status).toBe('cleared')
      expect(cheque.statusHistory).toHaveLength(5)
      expect(cheque.statusHistory.map((e) => e.to)).toEqual([
        'draft',
        'issued',
        'printed',
        'presented',
        'cleared',
      ])
    })

    it('allows a stop-payment path issued -> cancelled', () => {
      const cheque = makeCheque('issued').transitionTo('cancelled', {
        occurredAt: LATER,
        reason: 'stop payment',
      })
      expect(cheque.status).toBe('cancelled')
      expect(cheque.statusHistory.at(-1)?.reason).toBe('stop payment')
    })

    it('records the actor on a transition', () => {
      const cheque = makeCheque().transitionTo('issued', { occurredAt: NOW, actorId: 'user_7' })
      expect(cheque.statusHistory.at(-1)?.actorId).toBe('user_7')
    })
  })

  describe('illegal transitions are rejected', () => {
    const illegalPaths: Array<[string, string]> = [
      ['draft', 'cleared'],
      ['draft', 'printed'],
      ['draft', 'presented'],
      ['issued', 'draft'],
      ['printed', 'issued'],
      ['cleared', 'draft'],
      ['cancelled', 'issued'],
      ['cancelled', 'draft'],
      ['returned', 'cleared'],
    ]

    it.each(illegalPaths)('rejects %s -> %s', (from, to) => {
      expect(canTransition(from as never, to as never)).toBe(false)
      expect(() => assertTransition(from as never, to as never)).toThrow(
        InvalidChequeStatusTransitionError
      )
    })

    it('rejects a self-transition', () => {
      expect(canTransition('issued', 'issued')).toBe(false)
      expect(() => makeCheque('issued').transitionTo('issued', { occurredAt: LATER })).toThrow(
        InvalidChequeStatusTransitionError
      )
    })

    it('cannot leave a terminal state', () => {
      const cancelled = makeCheque('issued').transitionTo('cancelled', { occurredAt: LATER })
      expect(cancelled.isTerminal()).toBe(true)
      expect(cancelled.allowedTransitions()).toEqual([])

      for (const status of CHEQUE_STATUSES) {
        expect(() => cancelled.transitionTo(status, { occurredAt: LATER })).toThrow(
          InvalidChequeStatusTransitionError
        )
      }
    })

    it('reports the allowed targets in the error', () => {
      try {
        makeCheque().transitionTo('cleared', { occurredAt: NOW })
        expect.unreachable('should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidChequeStatusTransitionError)
        const typed = error as InvalidChequeStatusTransitionError
        expect(typed.code).toBe('CHEQUE_STATUS_TRANSITION_INVALID')
        expect(typed.from).toBe('draft')
        expect(typed.to).toBe('cleared')
        expect([...typed.allowed].sort()).toEqual(['cancelled', 'issued'])
        expect(typed.message).toContain('draft')
        expect(typed.message).toContain('cleared')
      }
    })

    it('rejects an unknown status string', () => {
      expect(() => makeCheque().transitionTo('voided' as never, { occurredAt: NOW })).toThrow(
        /unknown cheque status/
      )
    })
  })

  describe('history is append-only and authoritative', () => {
    it('derives status from the history rather than storing it separately', () => {
      const cheque = makeCheque('issued')
      expect(statusFromHistory(cheque.statusHistory)).toBe('issued')
      // There is no writable status field on the persisted shape.
      expect(Object.keys(cheque.toData())).not.toContain('status')
      expect(cheque.status).toBe('issued')
    })

    it('never mutates the previous cheque instance', () => {
      const original = makeCheque()
      const issued = original.transitionTo('issued', { occurredAt: LATER })

      expect(original.status).toBe('draft')
      expect(original.statusHistory).toHaveLength(1)
      expect(issued.status).toBe('issued')
      expect(issued.statusHistory).toHaveLength(2)
      expect(issued).not.toBe(original)
    })

    it('returns a frozen history that cannot be pushed to', () => {
      const cheque = makeCheque()
      expect(Object.isFrozen(cheque.statusHistory)).toBe(true)
      expect(() => (cheque.statusHistory as unknown[]).push({})).toThrow()
    })

    it('appendStatusEntry returns a new frozen array', () => {
      const history = appendStatusEntry([], { from: null, to: 'draft', occurredAt: NOW })
      const extended = appendStatusEntry(history, { from: 'draft', to: 'issued', occurredAt: LATER })

      expect(history).toHaveLength(1)
      expect(extended).toHaveLength(2)
      expect(extended).not.toBe(history)
    })

    it('preserves the full audit trail across many transitions', () => {
      let cheque = makeCheque()
      cheque = cheque.transitionTo('issued', { occurredAt: NOW, actorId: 'a' })
      cheque = cheque.transitionTo('printed', { occurredAt: NOW, actorId: 'a' })
      cheque = cheque.transitionTo('presented', { occurredAt: LATER, actorId: 'b' })
      cheque = cheque.transitionTo('returned', { occurredAt: LATER, reason: 'insufficient funds', actorId: 'b' })

      expect(cheque.statusHistory).toHaveLength(5)
      expect(cheque.statusHistory.map((e) => `${e.from ?? 'null'}->${e.to}`)).toEqual([
        'null->draft',
        'draft->issued',
        'issued->printed',
        'printed->presented',
        'presented->returned',
      ])
      expect(cheque.status).toBe('returned')
    })

    it('updates updatedAt from the transition timestamp', () => {
      const cheque = makeCheque().transitionTo('issued', { occurredAt: LATER })
      expect(cheque.updatedAt).toBe(LATER)
    })
  })

  describe('allowedTransitions helper', () => {
    it('exposes reachable states for the UI', () => {
      expect([...allowedTransitions('draft')].sort()).toEqual(['cancelled', 'issued'])
      expect([...allowedTransitions('printed')].sort()).toEqual(['cancelled', 'presented', 'returned'])
      expect(allowedTransitions('cancelled')).toEqual([])
    })

    it('matches the entity view', () => {
      const cheque = makeCheque('issued')
      expect([...cheque.allowedTransitions()].sort()).toEqual([...allowedTransitions('issued')].sort())
      expect(cheque.canTransitionTo('printed')).toBe(true)
      expect(cheque.canTransitionTo('cleared')).toBe(false)
    })
  })

  describe('corrections are draft-only', () => {
    it('allows correcting a draft', () => {
      const cheque = makeCheque().withCorrections({ payeeName: 'Corrected Ltd', memo: 'inv 9' }, LATER)
      expect(cheque.payeeName).toBe('Corrected Ltd')
      expect(cheque.memo).toBe('inv 9')
      // Correcting is not a lifecycle event, so history is untouched.
      expect(cheque.statusHistory).toHaveLength(1)
      expect(cheque.status).toBe('draft')
    })

    it('refuses to correct an issued cheque', () => {
      const issued = makeCheque().transitionTo('issued', { occurredAt: NOW })
      expect(() => issued.withCorrections({ payeeName: 'Other' }, LATER)).toThrow(
        InvalidChequeStatusTransitionError
      )
    })

    it('cannot change the cheque number or amount through corrections', () => {
      const cheque = makeCheque()
      // Neither field is part of the corrections signature.
      const corrected = cheque.withCorrections({ memo: 'x' }, LATER)
      expect(corrected.chequeNumberValue).toBe('4567')
      expect(corrected.amount.toDecimalString()).toBe('250.00')
    })
  })
})
