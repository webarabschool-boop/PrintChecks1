/**
 * The persistence port for printing records.
 *
 * It is intentionally the same four-method shape as `@printchecks/cheque-core`'s `RecordStore`:
 * one record per key, no whole-collection blobs (storage rule S1). Structural compatibility is
 * what lets the application hand the SAME encrypted localStorage adapter to both packages — so
 * Phase 2 adds a namespace, not a second storage system. This package does not import the core
 * package (the printing engine has to work standalone in a worker or a backend), and a four-method
 * interface is a seam, not a domain model, so nothing is duplicated in the sense §16 forbids.
 */
export interface PrintingRecordStore {
  get<T = unknown>(key: string): Promise<T | null>
  set<T = unknown>(key: string, value: T): Promise<void>
  remove(key: string): Promise<void>
  keys(): Promise<string[]>
}

export interface PrintingRecord {
  readonly id: string
  readonly updatedAt: string
}

export interface Repository<T extends PrintingRecord> {
  save(record: T): Promise<{ readonly replaced: boolean }>
  findById(id: string): Promise<T | null>
  findAll(): Promise<T[]>
  delete(id: string): Promise<boolean>
  count(): Promise<number>
}
