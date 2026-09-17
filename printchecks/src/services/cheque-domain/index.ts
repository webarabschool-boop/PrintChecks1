/**
 * Public entry point of the cheque-domain application boundary (Phase 1).
 *
 *     Vue stores / views
 *       │  (only this module is ever imported)
 *       ▼
 *     services/cheque-domain  ← the ONLY place in the app allowed to import
 *       │                       `@printchecks/cheque-core` (via its root entry)
 *       ▼
 *     @printchecks/cheque-core  (canonical domain: Bank → BankAccount → ChequeBook → Cheque)
 *       │
 *       ▼
 *     SecureStorageRecordStore → secureStorage → localStorage (encryption preserved)
 *
 * The boundary never imports UI-layer modules (components, views, stores), and no UI
 * module may import `@printchecks/cheque-core` directly — both directions are guarded
 * by `__tests__/architecture-boundary.test.ts`.
 */

// Boundary facade + composition
export {
  ChequeDomainService,
  createAppChequeDomain,
  getChequeDomain,
  resetChequeDomainForTests,
  type AppChequeDomainOptions,
  type BoundaryMoneyInput,
  type ChequeDomainDiagnostics,
  type ChequeDomainServiceOptions,
  type CreateBankAccountBoundaryInput,
  type CreateBankBoundaryInput,
  type CreateChequeBookBoundaryInput,
  type ChequeBookSequenceConfig,
  type EntityMigrationCounts,
  type IssueChequeBoundaryInput,
  type IssueChequeBoundaryResult,
  type MigrationReport,
  type SyncLegacyCheckResult,
} from './ChequeDomainService'

// Persistence adapter
export {
  SecureStorageRecordStore,
  StorageAdapterError,
  DOMAIN_STORAGE_NAMESPACE,
  DOMAIN_KEY_PREFIX,
  type StringKeyValueStorage,
} from './persistence/SecureStorageRecordStore'

// Legacy data source (read-only over the legacy keys)
export {
  createSecureStorageLegacySource,
  createStaticLegacySource,
  LEGACY_KEYS,
  type LegacyDataSource,
  type LegacySnapshot,
} from './legacySource'

// Legacy → domain mapping (pure)
export {
  LEGACY_MIGRATION_BOOK_LABEL,
  LEGACY_MIGRATION_CURRENCY,
  deriveBankCode,
  legacyBankAccountId,
  legacyBankId,
  legacyChequeId,
  legacyMigrationChequeBookId,
  mapLegacyAmount,
  mapLegacyBankAccount,
  mapLegacyCheque,
  mapLegacyChequeDate,
  mapLegacyChequeNumber,
  matchLegacyAccountForCheck,
  normaliseBankName,
  toIsoTimestamp,
  type LegacyAccountMatch,
  type LegacyBankAccountShape,
  type LegacyCheckShape,
  type MappedLegacyAccount,
  type MappedLegacyCheque,
  type MappingFailure,
  type MappingResult,
} from './legacyMapping'

// Canonical core value objects the app's consumers legitimately need. Everything else
// in the app receives these through THIS module, never by importing the core package.
export { Money } from '@printchecks/cheque-core'
export type {
  Bank,
  BankAccount,
  Cheque,
  ChequeBook,
  ChequeStatus,
  RecordStore,
  TransactionGuarantee,
} from '@printchecks/cheque-core'

// ---------------------------------------------------------------------------
// Store-facing convenience
// ---------------------------------------------------------------------------

import { getChequeDomain } from './ChequeDomainService'
import type { LegacyCheckShape, MappingFailure } from './legacyMapping'

export interface LegacyCheckMirrorOutcome {
  readonly mirrored: boolean
  readonly chequeId?: string
  readonly chequeNumber?: string
  readonly reason?: string
}

/**
 * Best-effort mirror of one saved legacy check into the canonical domain store.
 *
 * Used by the check store's save path. The legacy `checkList` record remains fully
 * authoritative; this function NEVER throws and never blocks or fails the caller —
 * an unmappable or unreachable domain store is reported, not raised.
 */
export async function recordSavedLegacyCheck(
  legacyCheck: LegacyCheckShape
): Promise<LegacyCheckMirrorOutcome> {
  try {
    const result = await getChequeDomain().syncLegacyCheck(legacyCheck)
    if (result.ok) {
      return { mirrored: true, chequeId: result.chequeId, chequeNumber: result.chequeNumber }
    }
    return { mirrored: false, reason: result.failure.reason }
  } catch (error) {
    const failure: MappingFailure = {
      kind: 'cheque',
      legacyId: typeof legacyCheck.id === 'string' ? legacyCheck.id : null,
      reason: error instanceof Error ? error.message : String(error),
    }
    console.warn('[cheque-domain] domain mirror skipped; legacy record stays authoritative:', failure.reason)
    return { mirrored: false, reason: failure.reason }
  }
}
