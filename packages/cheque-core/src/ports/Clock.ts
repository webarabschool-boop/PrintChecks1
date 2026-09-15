import type { IsoTimestamp } from '../domain/entities/Bank'

/**
 * Time source.
 *
 * Callers are expected to pass timestamps in, and {@link ChequeCore} always does so from
 * an injected clock. Entity factories accept an omitted `createdAt` and fall back to
 * `new Date().toISOString()` purely as a convenience — that fallback is the ONLY clock
 * read anywhere in the domain, and no identifier, sequence value or business rule is ever
 * derived from a clock or a random source.
 */
export interface Clock {
  now(): IsoTimestamp
}

/** Default clock. Lives in infrastructure, not in the domain. */
export class SystemClock implements Clock {
  now(): IsoTimestamp {
    return new Date().toISOString()
  }
}

/** Fixed clock for deterministic tests and for replaying imported data. */
export class FixedClock implements Clock {
  constructor(private timestamp: IsoTimestamp) {}

  now(): IsoTimestamp {
    return this.timestamp
  }

  set(timestamp: IsoTimestamp): void {
    this.timestamp = timestamp
  }

  /** Advance by a whole number of milliseconds. */
  advanceBy(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds)) {
      throw new TypeError('FixedClock.advanceBy requires a safe integer number of milliseconds')
    }
    this.timestamp = new Date(Date.parse(this.timestamp) + milliseconds).toISOString()
  }
}
