import type { TransactionCapabilities } from '../../ports/repositories'

/**
 * Minimal key/value persistence port.
 *
 * This is a STRUCTURAL SUBSET of `@printchecks/core`'s `StorageAdapter`
 * (`packages/core/src/storage/StorageAdapter.ts:5-42`), so an existing
 * `LocalStorageAdapter` or `SecureStorageAdapter` can be handed to this package directly
 * with no dependency and no wrapper. The sound part of the legacy storage design is
 * reused; the unsound part — writing a whole collection as one JSON blob — is not.
 */
export interface RecordStore {
  get<T = unknown>(key: string): Promise<T | null>
  set<T = unknown>(key: string, value: T): Promise<void>
  remove(key: string): Promise<void>
  keys(): Promise<string[]>
}

/**
 * Volatile {@link RecordStore} for tests, storybooks and ephemeral sessions.
 * Nothing is written to any platform API, so it works in Node and in the browser alike.
 */
export class InMemoryRecordStore implements RecordStore {
  private readonly records = new Map<string, unknown>()
  private failureMode: 'none' | 'set' | 'remove' = 'none'

  async get<T = unknown>(key: string): Promise<T | null> {
    const value = this.records.get(key)
    return value === undefined ? null : (value as T)
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    if (this.failureMode === 'set') {
      throw new Error(`InMemoryRecordStore: simulated write failure for key "${key}"`)
    }
    this.records.set(key, value)
  }

  async remove(key: string): Promise<void> {
    if (this.failureMode === 'remove') {
      throw new Error(`InMemoryRecordStore: simulated remove failure for key "${key}"`)
    }
    this.records.delete(key)
  }

  async keys(): Promise<string[]> {
    return [...this.records.keys()]
  }

  /** Test hook: make subsequent writes fail, to exercise rollback paths. */
  simulateFailure(mode: 'none' | 'set' | 'remove'): void {
    this.failureMode = mode
  }

  get size(): number {
    return this.records.size
  }

  clear(): void {
    this.records.clear()
  }
}

/**
 * Capabilities reported when persisting through a plain {@link RecordStore}.
 *
 * Honest by default: records are written one key at a time, so a failure part-way through
 * a flush can leave partial state. An adapter backed by a real transactional database
 * should report `atomic` instead.
 */
export const RECORD_STORE_CAPABILITIES: TransactionCapabilities = {
  guarantee: 'best-effort',
  limitation:
    'Records are written individually to a key/value store with no multi-key transaction. ' +
    'The unit of work stages changes and rolls back on failure, but a crash during the flush ' +
    'itself can leave partial state.',
}
