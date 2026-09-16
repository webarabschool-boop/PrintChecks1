import { RECORD_STORE_CAPABILITIES, type RecordStore } from './RecordStore'
import type { TransactionCapabilities } from '../../ports/repositories'

/**
 * Minimal structural view of `window.localStorage`.
 *
 * Declared locally so the package needs no DOM lib types. Any object with this shape works,
 * which also makes the adapter trivially testable with a fake.
 */
export interface WebStorageLike {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function isWebStorageLike(candidate: unknown): candidate is WebStorageLike {
  if (candidate === null || typeof candidate !== 'object') return false
  const storage = candidate as Partial<WebStorageLike>
  return (
    typeof storage.getItem === 'function' &&
    typeof storage.setItem === 'function' &&
    typeof storage.removeItem === 'function' &&
    typeof storage.key === 'function'
  )
}

function platformLocalStorage(): WebStorageLike | null {
  const candidate = (globalThis as { localStorage?: unknown }).localStorage
  return isWebStorageLike(candidate) ? candidate : null
}

export interface LocalStorageRecordStoreOptions {
  /** Explicit storage instance; defaults to `globalThis.localStorage` when available. */
  readonly storage?: WebStorageLike
  /** Only keys starting with this prefix are visible to this store. */
  readonly keyPrefix?: string
}

/** Raised when localStorage is unavailable (private mode, SSR, disabled by policy). */
export class LocalStorageUnavailableError extends Error {
  readonly code = 'LOCAL_STORAGE_UNAVAILABLE'
  constructor() {
    super(
      'localStorage is not available in this environment. Cheque data cannot be persisted; ' +
        'supply a different RecordStore (IndexedDB, SQL or an API adapter) instead.'
    )
    this.name = 'LocalStorageUnavailableError'
  }
}

/**
 * {@link RecordStore} backed by `localStorage`, storing each record as its own JSON value.
 *
 * Unlike the legacy `LocalStorageAdapter` usage in `packages/core` — where an entire
 * collection was serialised into ONE key (`printchecks:checks`) and rewritten on every
 * save — this stores one key per record. Consequences:
 *
 *   - a corrupted record affects one cheque, not the whole ledger;
 *   - a save writes one small value instead of re-serialising every cheque ever created;
 *   - per-record diffing and sync become possible later.
 *
 * The transactional limitation is unchanged and is reported honestly through
 * {@link RECORD_STORE_CAPABILITIES}: `localStorage` has no transactions, so a crash between
 * two `setItem` calls can leave partial state.
 */
export class LocalStorageRecordStore implements RecordStore {
  private readonly storage: WebStorageLike
  private readonly keyPrefix: string

  constructor(options: LocalStorageRecordStoreOptions = {}) {
    // Validate an explicitly supplied storage too, not just the platform lookup: an
    // object that only looks like localStorage would otherwise fail later, mid-write,
    // with a confusing error instead of at construction.
    const storage = options.storage ?? platformLocalStorage()
    if (!isWebStorageLike(storage)) throw new LocalStorageUnavailableError()
    this.storage = storage
    this.keyPrefix = options.keyPrefix ?? ''
  }

  /** Whether a usable localStorage exists in this environment. */
  static isAvailable(): boolean {
    return platformLocalStorage() !== null
  }

  private fullKey(key: string): string {
    return `${this.keyPrefix}${key}`
  }

  private stripPrefix(fullKey: string): string | null {
    if (this.keyPrefix.length === 0) return fullKey
    return fullKey.startsWith(this.keyPrefix) ? fullKey.slice(this.keyPrefix.length) : null
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const raw = this.storage.getItem(this.fullKey(key))
    if (raw === null) return null
    return JSON.parse(raw) as T
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    // May throw QuotaExceededError; callers must treat that as a real failure.
    this.storage.setItem(this.fullKey(key), JSON.stringify(value))
  }

  async remove(key: string): Promise<void> {
    this.storage.removeItem(this.fullKey(key))
  }

  async keys(): Promise<string[]> {
    const result: string[] = []
    for (let index = 0; index < this.storage.length; index += 1) {
      const fullKey = this.storage.key(index)
      if (fullKey === null) continue
      const stripped = this.stripPrefix(fullKey)
      if (stripped !== null) result.push(stripped)
    }
    return result
  }
}

export const LOCAL_STORAGE_CAPABILITIES: TransactionCapabilities = RECORD_STORE_CAPABILITIES
