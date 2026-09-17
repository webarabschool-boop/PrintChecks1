import type { StringKeyValueStorage } from './persistence/SecureStorageRecordStore'
import { secureStorage } from '../secureStorage'
import type { LegacyBankAccountShape, LegacyCheckShape } from './legacyMapping'

/**
 * Read-side access to the legacy persistence keys.
 *
 * The legacy collections stay WHERE THEY ARE and HOW THEY ARE: the same keys, the same
 * whole-collection JSON blobs, the same secure-storage encryption policy. This source
 * is strictly read-only — migration mirrors data into the domain namespace and never
 * rewrites, reformats or deletes legacy keys.
 */

/** Legacy localStorage keys (stable since long before Phase 1). */
export const LEGACY_KEYS = {
  bankAccounts: 'bankAccounts',
  checks: 'checkList',
} as const

export interface LegacySnapshot {
  readonly bankAccounts: readonly LegacyBankAccountShape[]
  readonly checks: readonly LegacyCheckShape[]
}

export interface LegacyDataSource {
  /**
   * Load the legacy snapshot. Implementations must tolerate missing keys (empty arrays)
   * and must surface un-parseable content as an error instead of fabricating data.
   */
  load(): Promise<LegacySnapshot>
}

async function readArray(storage: StringKeyValueStorage, key: string): Promise<unknown[]> {
  const raw = await storage.get(key)
  if (raw === null || raw.length === 0) return []
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error(`legacy key "${key}" is not a JSON array; refusing to interpret it`)
  }
  return parsed
}

/** Build the source over the app secure-storage service (default) or a compatible one. */
export function createSecureStorageLegacySource(
  storage: StringKeyValueStorage = secureStorage
): LegacyDataSource {
  return {
    async load(): Promise<LegacySnapshot> {
      const [bankAccounts, checks] = await Promise.all([
        readArray(storage, LEGACY_KEYS.bankAccounts),
        readArray(storage, LEGACY_KEYS.checks),
      ])
      return {
        bankAccounts: bankAccounts as LegacyBankAccountShape[],
        checks: checks as LegacyCheckShape[],
      }
    },
  }
}

/** In-memory source for tests and tooling. */
export function createStaticLegacySource(snapshot: LegacySnapshot): LegacyDataSource {
  return {
    async load(): Promise<LegacySnapshot> {
      return snapshot
    },
  }
}
