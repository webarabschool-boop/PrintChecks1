import { describe, expect, it } from 'vitest'
import { PrintJobTransitionError } from '../../errors'
import {
  CANCELLABLE_STATUSES,
  TERMINAL_STATUSES,
  canTransition,
  createPrintJob,
  documentFingerprint,
  isCancellable,
  isSettled,
  legalTransitions,
  retryJob,
  transitionJob,
  verifyJobRecord,
  type ChequePrintJob,
} from '../PrintJob'
import { fixtureCalibration, fixtureData, fixtureLayout, fixtureProfile, fixtureTemplate, FIXED_AT } from './fixture'

const layout = fixtureLayout()

function job(overrides: Partial<Parameters<typeof createPrintJob>[0]> = {}): ChequePrintJob {
  return createPrintJob({
    id: 'job-1',
    chequeId: 'cheque-0001',
    chequeNumber: '001234',
    layout,
    printerProfileId: 'hp-m402',
    calibrationId: 'cal-hp-nbe',
    calibrationFingerprint: null,
    createdBy: 'teller-1',
    createdAt: FIXED_AT,
    ...overrides,
  })
}

const to = (status: ChequePrintJob['status'], options: Parameters<typeof transitionJob>[2] = {}) =>
  transitionJob(job(), status, { at: FIXED_AT, ...options })

describe('the pin: what a print record must nail down (A4)', () => {
  it('records the template version, the template hash and the layout hash', () => {
    const record = job()
    expect(record.pin).toEqual({
      templateId: 'nbe-personal-en-2024',
      templateVersion: 1,
      templateHash: fixtureTemplate().templateHash,
      layoutHash: layout.layoutHash,
      printerProfileId: 'hp-m402',
      calibrationId: 'cal-hp-nbe',
      calibrationFingerprint: null,
    })
  })

  it('stores the layout itself, not a pointer to the current template', () => {
    const record = job()
    expect(record.layout.runs.length).toBe(layout.runs.length)
    expect(record.layout.runs[0]?.text).toBe(layout.runs[0]?.text)
    expect(record.layout.runs[0]?.xMm).toBe(layout.runs[0]?.xMm)
  })

  it('records "no calibration" as a decision, not as a blank', () => {
    const record = job({ calibrationId: null, calibrationFingerprint: null })
    expect(record.pin.calibrationId).toBeNull()
    expect(record.pin.calibrationFingerprint).toBeNull()
  })

  it('starts life as a created job with an empty history of one', () => {
    const record = job()
    expect(record.status).toBe('created')
    expect(record.attempt).toBe(0)
    expect(record.isReprint).toBe(false)
    expect(record.reprintOfJobId).toBeNull()
    expect(record.failure).toBe(null)
    expect(record.sentAt).toBeNull()
    expect(record.history).toHaveLength(1)
    expect(record.history[0]?.status).toBe('created')
    expect(Object.isFrozen(record)).toBe(true)
  })

  it('keeps the cheque number as the exact string it was given', () => {
    expect(job({ chequeNumber: '0012/2026-SB' }).chequeNumber).toBe('0012/2026-SB')
  })
})

describe('the job lifecycle', () => {
  it('walks the happy path in order and stamps each stage', () => {
    let record = to('queued')
    record = transitionJob(record, 'authorised', { at: FIXED_AT, actorId: 'manager-1', reason: 'verified against the invoice' })
    record = transitionJob(record, 'rendering', { at: FIXED_AT })
    const printed = { html: '<html>a cheque</html>', runCount: layout.runCount }
    const fingerprint = documentFingerprint(printed.html, printed.runCount)
    record = transitionJob(record, 'sent', {
      at: FIXED_AT,
      transportId: 'iframe-print',
      document: fingerprint,
    })
    const done = transitionJob(record, 'completed', { at: FIXED_AT, note: 'operator confirmed the sheet' })

    expect(done.status).toBe('completed')
    expect(done.queuedAt).toBe(FIXED_AT)
    expect(done.authorizedAt).toBe(FIXED_AT)
    expect(done.sentAt).toBe(FIXED_AT)
    expect(done.completedAt).toBe(FIXED_AT)
    expect(done.authorizedBy).toBe('manager-1')
    expect(done.authorizationReason).toBe('verified against the invoice')
    expect(done.transportId).toBe('iframe-print')
    expect(done.document).toEqual({ mimeType: 'text/html', ...fingerprint, runCount: layout.runCount })
    expect(done.history.map((event) => event.status)).toEqual([
      'created',
      'queued',
      'authorised',
      'rendering',
      'sent',
      'completed',
    ])
    expect(verifyJobRecord(done).ok).toBe(true)
  })

  it('refuses to skip a stage, or to go backwards', () => {
    expect(() => to('sent')).toThrow(PrintJobTransitionError)
    expect(() => to('sent')).toThrow(/illegal print-job transition "created" → "sent"/)
    expect(() => to('sent')).toThrow(/Legal path: created → queued/)
    expect(() => transitionJob(to('queued'), 'created')).toThrow(PrintJobTransitionError)
  })

  it('will not authorise a job without naming who authorised it', () => {
    const queued = to('queued')
    expect(() => transitionJob(queued, 'authorised', { at: FIXED_AT })).toThrow(/no authorising actor/)
    expect(() => transitionJob(queued, 'authorised', { at: FIXED_AT, actorId: '' })).toThrow(/no authorising actor/)
  })

  it('will not authorise a reprint without a reason, because a reprinted cheque can be a duplicate cheque', () => {
    const reprint = job({ reprintOf: job() })
    const queued = transitionJob(reprint, 'queued', { at: FIXED_AT })
    expect(() => transitionJob(queued, 'authorised', { at: FIXED_AT, actorId: 'manager-1' })).toThrow(/needs a recorded reason/)
    expect(transitionJob(queued, 'authorised', { at: FIXED_AT, actorId: 'manager-1', reason: 'first sheet jammed' }).status).toBe('authorised')
  })

  it('lists the legal moves so the UI can disable a button instead of guessing', () => {
    expect(legalTransitions('created')).toEqual(['queued', 'cancelled'])
    expect(legalTransitions('completed')).toEqual([])
    expect(canTransition('sent', 'completed')).toBe(true)
    expect(canTransition('sent', 'cancelled')).toBe(false)
    expect(CANCELLABLE_STATUSES).toEqual(['created', 'queued', 'authorised', 'rendering'])
    expect(TERMINAL_STATUSES).toEqual(['completed', 'cancelled'])
  })

  it('cancels up to the moment the sheet is in the printer, and never after', () => {
    const created = job()
    expect(isCancellable(created)).toBe(true)
    const cancelled = transitionJob(created, 'cancelled', { at: FIXED_AT, actorId: 'teller-1', note: 'wrong payee' })
    expect(cancelled.status).toBe('cancelled')
    expect(isCancellable(cancelled)).toBe(false)
    expect(isSettled(cancelled)).toBe(true)
    const queued = to('queued')
    expect(() => transitionJob(queued, 'cancelled', { at: FIXED_AT })).not.toThrow()
  })

  it('records a failure with its code and message, and clears it on a retry', () => {
    const rendering = transitionJob(to('queued'), 'rendering', { at: FIXED_AT })
    const failed = transitionJob(rendering, 'failed', {
      at: FIXED_AT,
      failure: { code: 'TRANSPORT_TIMEOUT', message: 'the print dialog never returned' },
    })
    expect(failed.failure).toEqual({ code: 'TRANSPORT_TIMEOUT', message: 'the print dialog never returned', at: FIXED_AT })
    expect(failed.status).toBe('failed')

    const retried = retryJob(failed, { at: FIXED_AT, actorId: 'teller-1', reason: 'retried after reconnecting' })
    expect(retried.status).toBe('queued')
    expect(retried.attempt).toBe(1)
    expect(retried.isReprint).toBe(true)
    expect(retried.failure).toBeNull()
    expect(retried.history.at(-1)?.note).toBe('retried after reconnecting')
  })

  it('gives a bare failure a code, so no record can be unexplained', () => {
    const failed = transitionJob(transitionJob(to('queued'), 'failed', { at: FIXED_AT }), 'queued', { at: FIXED_AT })
    expect(failed.status).toBe('queued')
    const bare = transitionJob(to('queued'), 'failed', { at: FIXED_AT })
    expect(bare.failure?.code).toBe('PRINT_FAILED')
  })

  it('reopens a failed job for a retry, and a retry of a reprint keeps pointing at the original', () => {
    const original = job()
    const reprint = job({ reprintOf: original })
    expect(reprint.attempt).toBe(1)
    expect(reprint.isReprint).toBe(true)
    expect(reprint.reprintOfJobId).toBe('job-1')
    expect(reprint.history[0]?.note).toBe('reprint of job-1')

    const queued = transitionJob(reprint, 'queued', { at: FIXED_AT })
    const failed = transitionJob(transitionJob(queued, 'rendering', { at: FIXED_AT }), 'failed', { at: FIXED_AT })
    // A retry cannot come from `rendering` directly: the failure has to be recorded first.
    expect(() => retryJob(transitionJob(reprint, 'queued', { at: FIXED_AT }), { at: FIXED_AT })).toThrow(PrintJobTransitionError)
    const retried = retryJob(failed, { at: FIXED_AT })
    expect(retried.status).toBe('queued')
    expect(retried.attempt).toBe(2)
    expect(retried.reprintOfJobId).toBe('job-1')
  })

  it('counts attempts so a ruined sheet still consumes the cheque number', () => {
    let record: ChequePrintJob = job()
    for (let index = 0; index < 3; index += 1) {
      // A retry lands in `queued`, so only the first pass has to enter the queue.
      const queued = record.status === 'queued' ? record : transitionJob(record, 'queued', { at: FIXED_AT })
      const rendering = transitionJob(queued, 'rendering', { at: FIXED_AT })
      const failed = transitionJob(rendering, 'failed', { at: FIXED_AT })
      record = retryJob(failed, { at: FIXED_AT })
      expect(record.attempt).toBe(index + 1)
      expect(record.pin).toEqual(job().pin)
      expect(verifyJobRecord(record).ok).toBe(true)
    }
    expect(record.attempt).toBe(3)
    expect(record.isReprint).toBe(true)
    expect(record.history).toHaveLength(11)
  })
})

describe('record integrity', () => {
  it('verifies a job against the layout it pins', () => {
    expect(verifyJobRecord(job()).ok).toBe(true)
  })

  it('catches a stored layout that no longer matches the pin', () => {
    const record = job()
    const edited = { ...record, layout: { ...record.layout, layoutHash: 'other-hash' } } as ChequePrintJob
    const result = verifyJobRecord(edited)
    expect(result.ok).toBe(false)
    expect(result.problems.join('\n')).toContain('does not match the pinned layout')
  })

  it('catches a job whose layout belongs to another template or version', () => {
    const record = job()
    expect(
      verifyJobRecord({ ...record, layout: { ...record.layout, templateId: 'other' } } as ChequePrintJob).problems.join('\n')
    ).toContain('different template')
    expect(
      verifyJobRecord({ ...record, layout: { ...record.layout, templateVersion: 9 } } as ChequePrintJob).problems.join('\n')
    ).toContain('pins v1')
  })

  it('catches a document hash that was not produced by the recorded bytes', () => {
    const record = transitionJob(to('queued'), 'rendering', { at: FIXED_AT })
    const withDoc = transitionJob(record, 'sent', { at: FIXED_AT, document: { bytes: 10, hash: 'made-up' } })
    expect(verifyJobRecord(withDoc).problems.join('\n')).toContain('document hash does not match')
  })

  it('catches an attempt counter that was edited without marking the job a reprint', () => {
    const record = { ...job(), attempt: 2 } as ChequePrintJob
    expect(verifyJobRecord(record).problems.join('\n')).toContain('not marked as a reprint')
  })

  it('accepts a document fingerprint computed the same way the renderer records it', () => {
    const printed = fixtureProfile()
    const fingerprint = documentFingerprint('<html>cheque</html>', 2)
    const withDoc = transitionJob(
      transitionJob(transitionJob(job(), 'queued', { at: FIXED_AT }), 'rendering', { at: FIXED_AT }),
      'sent',
      { at: FIXED_AT, document: fingerprint }
    )
    expect(verifyJobRecord(withDoc).ok).toBe(true)
    expect(withDoc.document.bytes).toBe(fingerprint.bytes)
    expect(printed.id).toBe('hp-m402')
  })
})

describe('job inputs are validated where they arrive', () => {
  it('refuses a reprint against a different template than the original printed', () => {
    const other = fixtureLayout({ template: fixtureTemplate({ id: 'cib-corporate-en-2023' }) })
    expect(() =>
      createPrintJob({
        id: 'job-2',
        chequeId: null,
        chequeNumber: '0099',
        layout: other,
        printerProfileId: 'hp-m402',
        calibrationId: null,
        calibrationFingerprint: null,
        createdBy: null,
        reprintOf: job(),
      })
    ).toThrow(/but the original printed/)
  })

  it('keeps the calibration that was in force, so a later re-calibration cannot rewrite history', () => {
    const calibration = fixtureCalibration()
    const record = job({ calibrationId: calibration.id, calibrationFingerprint: 'fp-123' })
    expect(record.pin.calibrationFingerprint).toBe('fp-123')
    expect(record.pin.calibrationId).toBe('cal-hp-nbe')
  })

  it('does not carry the cheque data beyond what the layout already printed', () => {
    const record = job()
    const json = JSON.stringify(record)
    expect(json).toContain('Crescent Trading LLC')
    expect(json).not.toContain('accountNumber')
    expect(fixtureData().payeeName).toBe('Crescent Trading LLC')
  })
})
