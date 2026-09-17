import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  SecureStorageRecordStore,
  StorageAdapterError,
  DOMAIN_KEY_PREFIX,
  DOMAIN_STORAGE_NAMESPACE,
  type StringKeyValueStorage,
} from '../persistence/SecureStorageRecordStore'
import { secureStorage } from '../../secureStorage'
import { isEncrypted } from '../../encryption'

/** In-memory Storage stand-in (vitest runs in the node environment). */
class MemoryStorage implements Storage {
  private readonly records = new Map<string, string>()

  get length(): number {
    return this.records.size
  }
  clear(): void {
    this.records.clear()
  }
  getItem(key: string): string | null {
    return this.records.get(key) ?? null
  }
  key(index: number): string | null {
    return [...this.records.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.records.delete(key)
  }
  setItem(key: string, value: string): void {
    this.records.set(key, String(value))
  }

  rawValue(key: string): string | null {
    return this.records.get(key) ?? null
  }
}

const DOMAIN_KEY = `${DOMAIN_KEY_PREFIX}bank:bank:legacy:first national`

describe('SecureStorageRecordStore', () => {
  let memory: MemoryStorage

  beforeEach(() => {
    memory = new MemoryStorage()
    ;(globalThis as { localStorage?: Storage }).localStorage = memory
  })

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage
    vi.restoreAllMocks()
  })

  it('round-trips JSON records without touching their content', async () => {
    const store = new SecureStorageRecordStore(secureStorage)
    const record = { id: 'bnk_1', name: 'First National', nested: { ok: true }, list: [1, 2] }

    await store.set(DOMAIN_KEY, record)
    expect(await store.get(DOMAIN_KEY)).toEqual(record)
    expect(await store.get(`${DOMAIN_KEY_PREFIX}bank:missing`)).toBeNull()

    await store.remove(DOMAIN_KEY)
    expect(await store.get(DOMAIN_KEY)).toBeNull()
  })

  it('enumerates only keys under the versioned domain namespace', async () => {
    memory.setItem('checkList', '[]')
    memory.setItem('bankAccounts', '[]')
    memory.setItem('printchecks_receipts', '[]')
    memory.setItem(DOMAIN_KEY, '{}')
    memory.setItem(`${DOMAIN_KEY_PREFIX}cheque:cheque:legacy:c1`, '{}')

    const store = new SecureStorageRecordStore(secureStorage)
    const keys = await store.keys()

    expect(keys.sort()).toEqual([DOMAIN_KEY, `${DOMAIN_KEY_PREFIX}cheque:cheque:legacy:c1`].sort())
    expect(keys.some((key) => key === 'checkList')).toBe(false)
  })

  it('reports an empty key space when no platform storage exists', async () => {
    delete (globalThis as { localStorage?: Storage }).localStorage
    const store = new SecureStorageRecordStore(secureStorage)
    await expect(store.keys()).resolves.toEqual([])
  })

  it('registers the domain namespace as encryption-sensitive on capable storage', () => {
    const register = vi.fn()
    const stub: StringKeyValueStorage & { registerSensitiveKeyPrefixes: (...p: string[]) => void } = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      remove: vi.fn(),
      registerSensitiveKeyPrefixes: register,
    }
    new SecureStorageRecordStore(stub)
    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith(DOMAIN_KEY_PREFIX)
  })

  it('tolerates a structural storage stub without the registration extension', () => {
    const stub: StringKeyValueStorage = {
      get: async () => null,
      set: async () => undefined,
      remove: () => undefined,
    }
    expect(() => new SecureStorageRecordStore(stub)).not.toThrow()
  })

  it('refuses to interpret malformed stored JSON (fail loud, never guess)', async () => {
    memory.setItem(DOMAIN_KEY, '{not json')
    memory.setItem('encryption_enabled', 'not-true')
    secureStorage.initialize(null)

    const store = new SecureStorageRecordStore(secureStorage)
    await expect(store.get(DOMAIN_KEY)).rejects.toBeInstanceOf(StorageAdapterError)
  })

  it('exposes the documented versioned namespace', () => {
    expect(DOMAIN_STORAGE_NAMESPACE).toBe('printchecks:cheque:v1')
    expect(DOMAIN_KEY_PREFIX).toBe('printchecks:cheque:v1:')
  })

  describe('encryption behaviour (inherited from the app secure-storage service)', () => {
    beforeEach(() => {
      memory.setItem('encryption_enabled', 'true')
      secureStorage.initialize('correct horse battery staple')
    })

    afterEach(() => {
      secureStorage.initialize(null)
    })

    it('encrypts domain records at rest when app encryption is enabled', async () => {
      const store = new SecureStorageRecordStore(secureStorage)
      await store.set(DOMAIN_KEY, { payTo: 'Acme Corp', amount: '1250.75' })

      const rawAtRest = memory.rawValue(DOMAIN_KEY)
      expect(rawAtRest).not.toBeNull()
      expect(isEncrypted(rawAtRest as string)).toBe(true)
      expect(rawAtRest).not.toContain('Acme Corp')

      // …and decrypts transparently on read, unchanged.
      expect(await store.get(DOMAIN_KEY)).toEqual({ payTo: 'Acme Corp', amount: '1250.75' })
    })

    it('keeps legacy sensitive keys encrypted and non-sensitive keys plain — policy unchanged', async () => {
      new SecureStorageRecordStore(secureStorage)
      await secureStorage.set('checkList', JSON.stringify([{ payTo: 'Vendor' }]))
      await secureStorage.set('some_plain_ui_key', 'value')

      expect(isEncrypted(memory.rawValue('checkList') as string)).toBe(true)
      expect(isEncrypted(memory.rawValue('some_plain_ui_key') as string)).toBe(false)
    })

    it('stores domain records as plain text when encryption is disabled, matching legacy policy', async () => {
      memory.clear()
      memory.setItem('encryption_enabled', 'false')
      secureStorage.initialize(null)

      const store = new SecureStorageRecordStore(secureStorage)
      await store.set(DOMAIN_KEY, { payTo: 'Acme Corp' })

      const raw = memory.rawValue(DOMAIN_KEY) as string
      expect(isEncrypted(raw)).toBe(false)
      expect(raw).toContain('Acme Corp')
    })
  })
})
