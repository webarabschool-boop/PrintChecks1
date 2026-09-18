/**
 * Repositories over the {@link PrintingRecordStore} port.
 *
 * One record per key (`namespace:id`), never a whole-collection blob — storage rule S1, for the same
 * reason cheque-core applies it: a write that rewrites the entire collection can lose every other
 * record when it fails half way, and it makes an audit trail impossible to reason about. The last
 * write of `templates` as one JSON array is precisely how the legacy `printchecks_templates` key
 * behaves today.
 */

import type { PrintingRecordStore, Repository } from '../ports/recordStore'
import { deepFreeze } from '../template/BankChequeTemplate'
import type { BankChequeTemplate } from '../template/types'
import type { PrinterCalibration, PrinterProfile } from '../printer/types'
import type { ChequePrintJob } from '../printing/PrintJob'
import { verifyAuditChain, type PrintAuditRecord } from '../printing/audit'

export const PRINTING_STORAGE_NAMESPACE = 'printchecks:printing:v1'

export const PRINTING_KEY_PREFIXES = {
  template: `${PRINTING_STORAGE_NAMESPACE}:template`,
  profile: `${PRINTING_STORAGE_NAMESPACE}:profile`,
  calibration: `${PRINTING_STORAGE_NAMESPACE}:calibration`,
  job: `${PRINTING_STORAGE_NAMESPACE}:job`,
  audit: `${PRINTING_STORAGE_NAMESPACE}:audit`,
} as const

export interface TemplateRecord {
  readonly id: string
  readonly updatedAt: string
  readonly template: BankChequeTemplate
}

export interface ProfileRecord {
  readonly id: string
  readonly updatedAt: string
  readonly profile: PrinterProfile
}

export interface CalibrationRecord {
  readonly id: string
  readonly updatedAt: string
  readonly calibration: PrinterCalibration
}

export interface JobRecord {
  readonly id: string
  readonly updatedAt: string
  readonly job: ChequePrintJob
}

export interface AuditRecordEntry {
  readonly id: string
  readonly updatedAt: string
  readonly record: PrintAuditRecord
}

abstract class NamespaceRepository<T extends { id: string; updatedAt: string }> implements Repository<T> {
  protected constructor(
    protected readonly store: PrintingRecordStore,
    protected readonly namespace: string
  ) {}

  protected key(id: string): string {
    return `${this.namespace}:${id}`
  }

  async save(record: T): Promise<{ replaced: boolean }> {
    const id = this.key(record.id)
    const existing = await this.store.get<T>(id)
    await this.store.set(id, record)
    return { replaced: existing !== null }
  }

  async findById(id: string): Promise<T | null> {
    return await this.store.get<T>(this.key(id))
  }

  async findAll(): Promise<T[]> {
    const keys = (await this.store.keys()).filter((key) => key.startsWith(`${this.namespace}:`)).sort()
    const out: T[] = []
    for (const key of keys) {
      const record = await this.store.get<T>(key)
      if (record !== null) out.push(record)
    }
    return out
  }

  async delete(id: string): Promise<boolean> {
    const key = this.key(id)
    const existing = await this.store.get<T>(key)
    if (existing === null) return false
    await this.store.remove(key)
    return true
  }

  async count(): Promise<number> {
    const keys = await this.store.keys()
    return keys.filter((key) => key.startsWith(`${this.namespace}:`)).length
  }
}

export class TemplateRecordRepository extends NamespaceRepository<TemplateRecord> {
  constructor(store: PrintingRecordStore) {
    super(store, PRINTING_KEY_PREFIXES.template)
  }

  async saveTemplate(template: BankChequeTemplate): Promise<TemplateRecord> {
    const record: TemplateRecord = {
      id: `${template.id}:v${String(template.version)}`,
      updatedAt: template.updatedAt,
      template: deepFreeze(template),
    }
    await this.save(record)
    return record
  }

  async findTemplate(templateId: string, version: number): Promise<BankChequeTemplate | null> {
    const record = await this.findById(`${templateId}:v${String(version)}`)
    return record?.template ?? null
  }
}

export class ProfileRecordRepository extends NamespaceRepository<ProfileRecord> {
  constructor(store: PrintingRecordStore) {
    super(store, PRINTING_KEY_PREFIXES.profile)
  }

  async saveProfile(profile: PrinterProfile): Promise<ProfileRecord> {
    const record: ProfileRecord = { id: profile.id, updatedAt: profile.updatedAt, profile }
    await this.save(record)
    return record
  }
}

export class CalibrationRecordRepository extends NamespaceRepository<CalibrationRecord> {
  constructor(store: PrintingRecordStore) {
    super(store, PRINTING_KEY_PREFIXES.calibration)
  }

  async saveCalibration(calibration: PrinterCalibration): Promise<CalibrationRecord> {
    const record: CalibrationRecord = {
      id: `${calibration.printerProfileId}__${calibration.templateId}`,
      updatedAt: calibration.measuredAt,
      calibration,
    }
    await this.save(record)
    return record
  }

  async findForPair(printerProfileId: string, templateId: string): Promise<PrinterCalibration | null> {
    const record = await this.findById(`${printerProfileId}__${templateId}`)
    return record?.calibration ?? null
  }
}

export class JobRecordRepository extends NamespaceRepository<JobRecord> {
  constructor(store: PrintingRecordStore) {
    super(store, PRINTING_KEY_PREFIXES.job)
  }

  async saveJob(job: ChequePrintJob): Promise<JobRecord> {
    const record: JobRecord = { id: job.id, updatedAt: job.updatedAt, job }
    await this.save(record)
    return record
  }

  async findByChequeNumber(chequeNumber: string): Promise<ChequePrintJob[]> {
    const records = await this.findAll()
    return records
      .filter((entry) => entry.job.chequeNumber === chequeNumber)
      .map((entry) => entry.job)
  }

  async findRecent(): Promise<ChequePrintJob[]> {
    const records = await this.findAll()
    return records
      .map((entry) => entry.job)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
}

/**
 * Append-only. There is deliberately no `save`/`delete` on this class: an audit trail that can be
 * edited in place is a log that proves nothing (rule A1).
 */
export class AuditRecordRepository {
  constructor(protected readonly store: PrintingRecordStore) {}

  private get namespace(): string {
    return PRINTING_KEY_PREFIXES.audit
  }

  private key(sequence: number): string {
    return `${this.namespace}:${String(sequence).padStart(8, '0')}`
  }

  async append(record: PrintAuditRecord): Promise<void> {
    const key = this.key(record.sequence)
    const existing = await this.store.get<AuditRecordEntry>(key)
    if (existing !== null) {
      if (existing.record.integrityHash !== record.integrityHash) {
        throw new Error(
          `audit slot ${String(record.sequence)} already holds a different record — an audit trail is append-only`
        )
      }
      return
    }
    await this.store.set<AuditRecordEntry>(key, {
      id: record.id,
      updatedAt: record.occurredAt,
      record,
    })
  }

  async last(): Promise<PrintAuditRecord | null> {
    const all = await this.readAll()
    return all.length === 0 ? null : (all[all.length - 1] as PrintAuditRecord)
  }

  async readAll(): Promise<PrintAuditRecord[]> {
    const keys = (await this.store.keys())
      .filter((key) => key.startsWith(`${this.namespace}:`))
      .sort()
    const out: PrintAuditRecord[] = []
    for (const key of keys) {
      const entry = await this.store.get<AuditRecordEntry>(key)
      if (entry !== null) out.push(entry.record)
    }
    return out
  }

  async verify(): Promise<{ ok: boolean; problems: readonly string[]; length: number }> {
    const records = await this.readAll()
    const result = verifyAuditChain(records)
    return { ok: result.ok, problems: result.problems, length: result.length }
  }
}
