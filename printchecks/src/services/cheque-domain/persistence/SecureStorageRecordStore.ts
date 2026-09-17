import type { RecordStore } from '@printchecks/cheque-core'

import { secureStorage } from '../../secureStorage'

/**
 * Minimal structural view of the app secure-storage service.
 *
 * `SecureStorage` in `printchecks/src/services/secureStorage.ts` satisfies it, and tests
 * can hand in a plain stub. Values pass through unchanged: the service owns encryption
 * policy (and key selection), this adapter owns JSON (de)serialisation and namespacing.
 */
export interface StringKeyValueStorage {
  get(key: string): Promise<string | null>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): unknown
}

/** Optional extension added to SecureStorage in Phase 1 (called defensively). */
interface PrefixAwareStorage extends StringKeyValueStorage {
  registerSensitiveKeyPrefixes?: (...prefixes: string[]) => void
}

/**
 * Versioned domain storage namespace (Phase 1).
 *
 * It deliberately matches the default namespace of the cheque-core `ChequePersistence`
 * adapter and, just as deliberately, does NOT collide with any legacy collection key
 * (`checkList`, `bankAccounts`, `printchecks_receipts`, ...). Domain records therefore
 * coexist with legacy data during migration instead of overwriting it, and removing
 * them (rollback) is a contained, reversible operation: delete every key under
 * `${DOMAIN_STORAGE_NAMESPACE}:` and nothing else.
 */
export const DOMAIN_STORAGE_NAMESPACE = 'printchecks:cheque:v1'

/** Every persisted domain key starts with this prefix. */
export const DOMAIN_KEY_PREFIX = `${DOMAIN_STORAGE_NAMESPACE}:`

export class StorageAdapterError extends Error {
  readonly code = 'DOMAIN_STORAGE_ADAPTER_ERROR'
  constructor(
    message: string,
    readonly key: string | null,
    cause: unknown
  ) {
    super(message, cause instanceof Error ? { cause } : undefined)
    this.name = 'StorageAdapterError'
  }
}

function platformLocalStorage(): Storage | null {
  const candidate = (globalThis as { localStorage?: Storage }).localStorage
  return candidate ?? null
}

/**
 * Adapts the application's existing `secureStorage` service to the cheque-core
 * {@link RecordStore} port.
 *
 * ## Encryption is inherited, not reimplemented
 *
 * The secure-storage service decides what to encrypt: its exact-key allowlist plus any
 * registered sensitive-key PREFIXES. On construction this adapter registers the
 * versioned domain prefix, so every domain record (payees, amounts, account numbers)
 * follows the exact same policy as the legacy `checkList` / `bankAccounts` keys —
 * encrypted whenever the app's encryption subsystem is enabled and initialised, plain
 * otherwise. This adapter never decides policy by itself, so it cannot quietly leave a
 * freshly created domain record unencrypted.
 *
 * ## One record per key
 *
 * Keys are enumerated with the platform's `localStorage` directly, filtered to the
 * domain namespace, because the secure-storage service is a transparent pass-through
 * wrapper over those same keys. Records are JSON strings on the wire; the service may
 * additionally encrypt that string at rest.
 */
export class SecureStorageRecordStore implements RecordStore {
  private readonly storage: StringKeyValueStorage
  private readonly keyPrefixFilter: string

  constructor(
    storage: StringKeyValueStorage = secureStorage,
    options: { keyPrefixFilter?: string } = {}
  ) {
    this.storage = storage
    this.keyPrefixFilter = options.keyPrefixFilter ?? DOMAIN_KEY_PREFIX

    // Registering is additive and idempotent. The feature check keeps this adapter
    // usable with a plain structural stub (e.g. a test double that only implements
    // get/set/remove) without crashing.
    const candidate = this.storage as PrefixAwareStorage
    if (typeof candidate.registerSensitiveKeyPrefixes === 'function') {
      candidate.registerSensitiveKeyPrefixes(DOMAIN_KEY_PREFIX)
    }
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    let raw: string | null
    try {
      raw = await this.storage.get(key)
    } catch (error) {
      throw new StorageAdapterError(`failed to read domain record "${key}"`, key, error)
    }
    if (raw === null) return null

    try {
      return JSON.parse(raw) as T
    } catch (error) {
      throw new StorageAdapterError(
        `domain record "${key}" is not valid JSON and cannot be trusted`,
        key,
        error
      )
    }
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    let serialised: string
    try {
      serialised = JSON.stringify(value)
    } catch (error) {
      throw new StorageAdapterError(`domain record "${key}" is not serialisable`, key, error)
    }

    try {
      await this.storage.set(key, serialised)
    } catch (error) {
      throw new StorageAdapterError(`failed to persist domain record "${key}"`, key, error)
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await this.storage.remove(key)
    } catch (error) {
      throw new StorageAdapterError(`failed to remove domain record "${key}"`, key, error)
    }
  }

  /**
   * Keys under the domain namespace only. Legacy application keys are never enumerated,
   * touched or returned. With no platform storage available (e.g. a bare Node context)
   * the enumeration is empty, which the persistence layer treats as "no records yet".
   */
  async keys(): Promise<string[]> {
    const localStorageRef = platformLocalStorage()
    if (localStorageRef === null) return []

    const keys: string[] = []
    for (let index = 0; index < localStorageRef.length; index += 1) {
      const key = localStorageRef.key(index)
      if (key !== null && key.startsWith(this.keyPrefixFilter)) {
        keys.push(key)
      }
    }
    return keys
  }
}
