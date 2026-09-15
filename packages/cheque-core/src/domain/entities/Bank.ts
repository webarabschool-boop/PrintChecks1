import { RequiredFieldError, AggregateIntegrityError } from '../errors'

/** ISO-8601 timestamp string. Kept as a string so the domain never depends on `Date` behaviour. */
export type IsoTimestamp = string

export interface EntityTimestamps {
  readonly createdAt: IsoTimestamp
  readonly updatedAt: IsoTimestamp
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RequiredFieldError(field)
  }
  return value.trim()
}

export interface BankData extends EntityTimestamps {
  readonly id: string
  /** Internal, tenant-unique short code used for references and reporting. */
  readonly code: string
  readonly name: string
  /** Localised display name — supports Arabic/RTL deployments without a schema change. */
  readonly nameLocal?: string | null
  /**
   * ISO 3166-1 alpha-2 country code.
   *
   * Optional and uninterpreted: the domain does NOT embed country-specific banking
   * rules, cheque dimensions or MICR standards. Those arrive later via templates and
   * MICR profiles configured from real bank specifications.
   */
  readonly country?: string | null
  readonly isActive: boolean
}

export interface CreateBankInput {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly nameLocal?: string | null
  readonly country?: string | null
  readonly isActive?: boolean
  readonly createdAt?: IsoTimestamp
  readonly updatedAt?: IsoTimestamp
}

/**
 * Bank — a first-class domain entity.
 *
 * This replaces the legacy pattern of a denormalised free-text `bankName` string copied
 * onto every cheque and account (`packages/core/src/models/Check.ts:22`,
 * `packages/core/src/models/BankAccount.ts:20`), where renaming a bank meant rewriting
 * every historical record and two accounts at the same bank shared nothing but a string.
 *
 * A Bank owns BankAccounts; a BankAccount owns ChequeBooks; a ChequeBook owns Cheques.
 */
export class Bank {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly nameLocal: string | null
  readonly country: string | null
  readonly isActive: boolean
  readonly createdAt: IsoTimestamp
  readonly updatedAt: IsoTimestamp

  private constructor(data: BankData) {
    this.id = data.id
    this.code = data.code
    this.name = data.name
    this.nameLocal = data.nameLocal ?? null
    this.country = data.country ?? null
    this.isActive = data.isActive
    this.createdAt = data.createdAt
    this.updatedAt = data.updatedAt
  }

  static create(input: CreateBankInput): Bank {
    const id = requireText(input.id, 'Bank.id')
    const now = input.createdAt ?? new Date().toISOString()

    return new Bank({
      id,
      code: requireText(input.code, 'Bank.code'),
      name: requireText(input.name, 'Bank.name'),
      nameLocal: input.nameLocal ?? null,
      country: input.country ? requireText(input.country, 'Bank.country').toUpperCase() : null,
      isActive: input.isActive ?? true,
      createdAt: now,
      updatedAt: input.updatedAt ?? now,
    })
  }

  /** Best available display name, preferring the localised form when present. */
  displayName(): string {
    return this.nameLocal && this.nameLocal.length > 0 ? this.nameLocal : this.name
  }

  withChanges(
    changes: Partial<Pick<BankData, 'code' | 'name' | 'nameLocal' | 'country' | 'isActive'>>,
    updatedAt: IsoTimestamp
  ): Bank {
    return new Bank({
      ...this.toData(),
      ...changes,
      updatedAt,
    })
  }

  activate(updatedAt: IsoTimestamp): Bank {
    return this.withChanges({ isActive: true }, updatedAt)
  }

  deactivate(updatedAt: IsoTimestamp): Bank {
    return this.withChanges({ isActive: false }, updatedAt)
  }

  /**
   * Validate internal consistency.
   *
   * Bank identity is deliberately permissive about country-specific formats: a bank code
   * or SWIFT-style identifier varies by market, and inventing a rule here would encode an
   * assumption the product explicitly defers to real bank specifications.
   */
  validate(): void {
    if (this.id.trim().length === 0) throw new RequiredFieldError('Bank.id')
    if (this.code.trim().length === 0) throw new RequiredFieldError('Bank.code')
    if (this.name.trim().length === 0) throw new RequiredFieldError('Bank.name')
    if (this.country !== null && !/^[A-Z]{2}$/.test(this.country)) {
      throw new AggregateIntegrityError(
        `Bank.country must be an ISO 3166-1 alpha-2 code or null, received "${this.country}"`
      )
    }
  }

  toData(): BankData {
    return {
      id: this.id,
      code: this.code,
      name: this.name,
      nameLocal: this.nameLocal,
      country: this.country,
      isActive: this.isActive,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    }
  }

  toJSON(): BankData {
    return this.toData()
  }

  static fromJSON(data: BankData): Bank {
    const bank = new Bank({
      ...data,
      nameLocal: data.nameLocal ?? null,
      country: data.country ?? null,
    })
    bank.validate()
    return bank
  }
}
