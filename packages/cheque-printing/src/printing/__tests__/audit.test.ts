import { describe, expect, it } from 'vitest'
import {
  GENESIS_HASH,
  PRINT_AUDIT_ACTIONS,
  appendAuditRecord,
  computeAuditHash,
  describeAuditRecord,
  maskAccountNumber,
  verifyAuditChain,
  type AppendAuditInput,
  type PrintAuditRecord,
} from '../audit'

const AT = '2026-09-18T09:00:00.000Z'

function entry(id: string, action: AppendAuditInput['action'], overrides: Partial<AppendAuditInput> = {}): AppendAuditInput {
  return {
    id,
    occurredAt: AT,
    action,
    entityType: 'ChequePrintJob',
    entityId: 'job-1',
    context: { jobId: 'job-1', chequeNumber: '001234', templateId: 'nbe-personal-en-2024', templateVersion: 1, layoutHash: 'abc' },
    ...overrides,
  }
}

function chain(count: number): PrintAuditRecord[] {
  const records: PrintAuditRecord[] = []
  for (let index = 0; index < count; index += 1) {
    records.push(
      appendAuditRecord(records[index - 1] ?? null, entry(`ev-${String(index)}`, index === 0 ? 'job.created' : 'job.queued'))
    )
  }
  return records
}

describe('audit record construction', () => {
  it('covers every action the printing flow can take', () => {
    expect(PRINT_AUDIT_ACTIONS).toEqual(
      expect.arrayContaining([
        'template.published',
        'profile.created',
        'calibration.recorded',
        'testprint.generated',
        'job.created',
        'job.authorised',
        'job.sent',
        'job.completed',
        'job.failed',
        'job.retried',
        'job.cancelled',
        'safety.acknowledged',
        'safety.blocked',
      ])
    )
    expect(new Set(PRINT_AUDIT_ACTIONS).size).toBe(PRINT_AUDIT_ACTIONS.length)
  })

  it('starts a chain at the genesis link and numbers it from one', () => {
    const first = appendAuditRecord(null, entry('ev-0', 'job.created'))
    expect(first.sequence).toBe(1)
    expect(first.previousHash).toBe(GENESIS_HASH)
    const withoutHash = { ...first } as Record<string, unknown>
    delete withoutHash['integrityHash']
    expect(first.integrityHash).toBe(computeAuditHash(withoutHash as unknown as Omit<PrintAuditRecord, 'integrityHash'>))
  })

  it('links each record to the one before it', () => {
    const [a, b, c] = chain(3)
    expect(b?.previousHash).toBe(a?.integrityHash)
    expect(c?.previousHash).toBe(b?.integrityHash)
    expect(c?.sequence).toBe(3)
  })

  it('freezes the record, because an audit entry that can be edited is not one', () => {
    const record = appendAuditRecord(null, entry('ev-0', 'job.created'))
    expect(Object.isFrozen(record)).toBe(true)
    expect(() => {
      ;(record as { action: string }).action = 'job.completed'
    }).toThrow(TypeError)
  })

  it('is deterministic: the same event written twice hashes the same', () => {
    const a = appendAuditRecord(null, entry('ev-0', 'job.created'))
    const b = appendAuditRecord(null, entry('ev-0', 'job.created'))
    expect(a.integrityHash).toBe(b.integrityHash)
    expect(verifyAuditChain([a]).ok).toBe(true)
  })

  it('changes the hash when a timestamp moves, because when it happened is part of the fact', () => {
    const a = appendAuditRecord(null, entry('ev-0', 'job.created'))
    const b = appendAuditRecord(null, { ...entry('ev-0', 'job.created'), occurredAt: '2026-09-18T09:00:01.000Z' })
    expect(a.integrityHash).not.toBe(b.integrityHash)
  })
})

describe('the chain detects tampering', () => {
  it('accepts an intact chain of any length', () => {
    expect(verifyAuditChain([])).toEqual({ ok: true, length: 0, firstBrokenIndex: null, problems: [] })
    const records = chain(6)
    const result = verifyAuditChain(records)
    expect(result.ok).toBe(true)
    expect(result.length).toBe(6)
  })

  it('spots an edited record, even when its links still line up', () => {
    const records = chain(4)
    const tampered = records.map((record, index) =>
      index === 1 ? Object.freeze({ ...record, reason: ' rewritten after the fact ' }) : record
    )
    const result = verifyAuditChain(tampered)
    expect(result.ok).toBe(false)
    expect(result.firstBrokenIndex).toBe(1)
    expect(result.problems.join('\n')).toContain('edited after the fact')
    // Exactly one problem: the links still line up, which is precisely why the content hash exists —
    // it catches an edit that leaves the chain looking intact.
    expect(result.problems).toHaveLength(1)
  })

  it('spots a deleted record', () => {
    const records = chain(4)
    const withoutSecond = [records[0]!, records[2]!, records[3]!]
    const result = verifyAuditChain(withoutSecond)
    expect(result.ok).toBe(false)
    expect(result.firstBrokenIndex).toBe(1)
    expect(result.problems.join('\n')).toContain('links to')
  })

  it('spots a re-ordered chain', () => {
    const records = chain(3)
    const result = verifyAuditChain([records[0]!, records[2]!, records[1]!])
    expect(result.ok).toBe(false)
    expect(result.firstBrokenIndex).toBe(1)
  })

  it('spots a forged first record', () => {
    const records = chain(2)
    const forged = Object.freeze({ ...records[0]!, previousHash: 'deadbeefdeadbeef' })
    expect(verifyAuditChain([forged, records[1]!]).ok).toBe(false)
  })
})

describe('what the log is allowed to remember', () => {
  it('masks an account number to its last four digits', () => {
    expect(maskAccountNumber('1234567890123456')).toBe('************3456')
    expect(maskAccountNumber('1234')).toBe('****')
    expect(maskAccountNumber('12')).toBe('**')
    expect(maskAccountNumber('')).toBe('')
    expect(maskAccountNumber('  1234567890  ')).toBe('******7890')
  })

  it('masks sensitive values as the record is appended, so the raw number never reaches storage', () => {
    const record = appendAuditRecord(null, {
      ...entry('ev-0', 'job.sent'),
      values: {
        accountNumber: '1234567890123456',
        iban: 'EG820000000012345678901',
        payeeName: 'Crescent Trading LLC',
        amountDecimal: '1500.00',
        micrPrinted: false,
      },
    })
    expect(record.values?.accountNumber).toBe('************3456')
    const iban = record.values?.iban
    expect(typeof iban).toBe('string')
    expect(iban).toBe(`${'*'.repeat(19)}8901`)
    expect((iban as string).length).toBe('EG820000000012345678901'.length)
    expect(record.values?.payeeName).toBe('Cr…')
    expect(record.values?.amountDecimal).toBe('1500.00')
    expect(record.values?.micrPrinted).toBe(false)
    expect(JSON.stringify(record)).not.toContain('1234567890123456')
  })

  it('records a reprint as a reprint, with the job it replaces', () => {
    const record = appendAuditRecord(null, {
      ...entry('ev-9', 'job.retried'),
      reason: 'paper jam after 3 of 12 sheets',
      context: {
        jobId: 'job-9',
        reprintOfJobId: 'job-8',
        attempt: 1,
        isReprint: true,
        templateId: 'nbe-personal-en-2024',
      },
    })
    expect(record.context.isReprint).toBe(true)
    expect(record.context.reprintOfJobId).toBe('job-8')
    expect(record.reason).toContain('paper jam')
    expect(describeAuditRecord(record)).toContain('0001')
    expect(describeAuditRecord(record)).toContain('job.retried')
    expect(describeAuditRecord(record)).toContain('nbe-personal-en-2024 v?')
  })

  it('describes a job event with the layout it pinned, which is the whole point of the log', () => {
    const record = appendAuditRecord(null, entry('ev-1', 'job.sent'))
    expect(describeAuditRecord(record)).toBe(
      '0001 2026-09-18T09:00:00.000Z job.sent ChequePrintJob job-1 [nbe-personal-en-2024 v1 / abc]'
    )
  })

  it('describes a template event without a phantom layout hash', () => {
    const record = appendAuditRecord(null, {
      ...entry('ev-0', 'template.published'),
      entityType: 'BankChequeTemplate',
      entityId: 'nbe-personal-en-2024',
      context: {},
    })
    expect(describeAuditRecord(record)).toBe('0001 2026-09-18T09:00:00.000Z template.published BankChequeTemplate nbe-personal-en-2024')
  })
})
