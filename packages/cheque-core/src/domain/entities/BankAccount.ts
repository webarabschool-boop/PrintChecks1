import { RequiredFieldError, AggregateIntegrityError } from '../errors'
import { DefaultCurrencyRegistry } from '../value-objects/CurrencyRegistry'
import type { IsoTimestamp } from './Bank'

/**
 * Account type is an open string rather than a closed union.
 *
 * The legacy model hardcoded `'checking' | 'savings' | 'business'`
 * (`packages/core/src/models/BankAccount.ts:22`), which cannot describe account
 * classifications outside the US market. Common values are exported below as
 * documentation, not as a constraint.
 */
export type BankAccountType = string

export const COMMON_ACCOUNT_TYPES = {
  current: 'current',
  savings: 'savings',
  business: 'business',
  personal: 'personal',
} as const

export interface BankAccountData {
  readonly id: string
  /** Owning bank. Never optional — an account always belongs to a Bank. */
  readonly bankId: string
  readonly holderName: string
  /**
   * The bank's own account identifier, preserved EXACTLY as a string.
   *
   * No format validation is applied: account numbering schemes differ per bank and per
   * country, and inventing one would encode an unverified assumption. Leading zeros are
   * significant and must survive storage, display, search and export.
   */
  readonly accountNumber: string
  /** ISO 4217 code. Fixed per account; drives Money construction. */
  readonly currency: string
  readonly accountType: BankAccountType | null
  readonly branchCode: string | null
  readonly isDefault: boolean
  readonly isActive: boolean
  readonly createdAt: IsoTimestamp
  readonly updatedAt: IsoTimestamp
}

export interface CreateBankAccountInput {
  readonly id: string
  readonly bankId: string
  readonly holderName: string
  readonly accountNumber: string
  readonly currency: string
  readonly accountType?: BankAccountType | null
  readonly branchCode?: string | null
  readonly isDefault?: boolean
  readonly isActive?: boolean
  readonly createdAt?: IsoTimestamp
  readonly updatedAt?: IsoTimestamp
}

/**
 * BankAccount — a first-class domain entity belonging to a {@link Bank}.
 *
 * Splits apart the legacy entity that conflated the bank and the account: the app model
 * used a single `name` field to mean "bank name" while `accountHolderName` meant the
 * customer (`printchecks/src/types/bankAccount.ts`, rendered at `BankAccountModal.vue:20`),
 * and the core model carried a separate `bankName` string. Here the bank is referenced by
 * identity and the holder is a distinct attribute.
 */
export class BankAccount {
  readonly id: string
  readonly bankId: string
  readonly holderName: string
  readonly accountNumber: string
  readonly currency: string
  readonly accountType: BankAccountType | null
  readonly branchCode: string | null
  readonly isDefault: boolean
  readonly isActive: boolean
  readonly createdAt: IsoTimestamp
  readonly updatedAt: IsoTimestamp

  private constructor(data: BankAccountData) {
    this.id = data.id
    this.bankId = data.bankId
    this.holderName = data.holderName
    this.accountNumber = data.accountNumber
    this.currency = data.currency
    this.accountType = data.accountType
    this.branchCode = data.branchCode
    this.isDefault = data.isDefault
    this.isActive = data.isActive
    this.createdAt = data.createdAt
    this.updatedAt = data.updatedAt
  }

  static create(input: CreateBankAccountInput): BankAccount {
    const now = input.createdAt ?? new Date().toISOString()

    const account = new BankAccount({
      id: requireNonEmpty(input.id, 'BankAccount.id'),
      bankId: requireNonEmpty(input.bankId, 'BankAccount.bankId'),
      holderName: requireNonEmpty(input.holderName, 'BankAccount.holderName'),
      // Preserved verbatim — NOT trimmed of interior characters, NOT numerically parsed.
      accountNumber: requireNonEmpty(input.accountNumber, 'BankAccount.accountNumber'),
      currency: DefaultCurrencyRegistry.normalise(input.currency),
      accountType: input.accountType ?? null,
      branchCode: input.branchCode ?? null,
      isDefault: input.isDefault ?? false,
      isActive: input.isActive ?? true,
      createdAt: now,
      updatedAt: input.updatedAt ?? now,
    })

    account.validate()
    return account
  }

  /** Last four characters, for masked display. Never a substitute for access control. */
  maskedAccountNumber(): string {
    if (this.accountNumber.length <= 4) return this.accountNumber
    return `****${this.accountNumber.slice(-4)}`
  }

  withChanges(
    changes: Partial<
      Pick<
        BankAccountData,
        | 'holderName'
        | 'accountNumber'
        | 'currency'
        | 'accountType'
        | 'branchCode'
        | 'isDefault'
        | 'isActive'
      >
    >,
    updatedAt: IsoTimestamp
  ): BankAccount {
    const next = new BankAccount({ ...this.toData(), ...changes, updatedAt })
    next.validate()
    return next
  }

  validate(): void {
    if (this.id.trim().length === 0) throw new RequiredFieldError('BankAccount.id')
    if (this.bankId.trim().length === 0) {
      throw new AggregateIntegrityError('BankAccount.bankId is required; an account must belong to a Bank')
    }
    if (this.holderName.trim().length === 0) throw new RequiredFieldError('BankAccount.holderName')
    if (this.accountNumber.trim().length === 0) {
      throw new RequiredFieldError('BankAccount.accountNumber')
    }
    if (!/^[A-Z]{3}$/.test(this.currency)) {
      throw new AggregateIntegrityError(
        `BankAccount.currency must be an ISO 4217 code, received "${this.currency}"`
      )
    }
  }

  toData(): BankAccountData {
    return {
      id: this.id,
      bankId: this.bankId,
      holderName: this.holderName,
      accountNumber: this.accountNumber,
      currency: this.currency,
      accountType: this.accountType,
      branchCode: this.branchCode,
      isDefault: this.isDefault,
      isActive: this.isActive,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    }
  }

  toJSON(): BankAccountData {
    return this.toData()
  }

  static fromJSON(data: BankAccountData): BankAccount {
    const account = new BankAccount(data)
    account.validate()
    return account
  }
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RequiredFieldError(field)
  }
  return value.trim()
}
