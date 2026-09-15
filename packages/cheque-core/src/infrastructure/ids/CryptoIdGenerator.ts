import type { IdGenerator, IdentifierKind } from '../../ports/IdGenerator'

/**
 * Minimal structural view of the platform Web Crypto API.
 *
 * Declared locally so this package needs no DOM lib types: the domain core is built with
 * `lib: ["ES2022"]` and must stay platform-agnostic, while infrastructure may still use
 * whatever crypto the host provides.
 */
interface CryptoLike {
  randomUUID?: () => string
  getRandomValues?: <T extends Uint8Array>(array: T) => T
}

function platformCrypto(): CryptoLike | undefined {
  const candidate = (globalThis as { crypto?: unknown }).crypto
  if (candidate === null || typeof candidate !== 'object') return undefined
  return candidate as CryptoLike
}

const PREFIXES: Readonly<Record<IdentifierKind, string>> = {
  bank: 'bnk',
  bankAccount: 'acc',
  chequeBook: 'cbk',
  cheque: 'chq',
  transaction: 'txn',
}

/**
 * Cryptographically-random identifier generator.
 *
 * Replaces `Date.now().toString(36) + Math.random().toString(36).substring(2, 9)`
 * (`packages/core/src/services/CheckService.ts:108`, `BankAccountService.ts:51`,
 * `printchecks/src/stores/check.ts:350`). That scheme collides for entities created in the
 * same millisecond, is not RFC 4122, and — critically for an offline-first app that may
 * later sync — depends on `Math.random`, which is not collision-resistant across devices.
 *
 * There is deliberately NO `Math.random` fallback. If the platform provides no secure
 * random source this generator THROWS, because silently minting weak identifiers for
 * financial records is worse than refusing to start.
 *
 * The generated id is an internal surrogate only. It is never used as, derived from, or
 * interchangeable with a `chequeNumber`.
 */
export class CryptoIdGenerator implements IdGenerator {
  next(kind: IdentifierKind): string {
    const prefix = PREFIXES[kind]
    if (prefix === undefined) {
      throw new TypeError(`Unknown identifier kind: ${String(kind)}`)
    }
    return `${prefix}_${CryptoIdGenerator.randomUuid()}`
  }

  /** A bare RFC 4122 version-4 UUID, for callers that must not carry a prefix. */
  static randomUuid(): string {
    const crypto = platformCrypto()

    if (typeof crypto?.randomUUID === 'function') {
      return crypto.randomUUID()
    }

    if (typeof crypto?.getRandomValues === 'function') {
      const bytes = crypto.getRandomValues(new Uint8Array(16))
      // Set version (4) and variant (10xx) bits per RFC 4122.
      bytes[6] = (bytes[6]! & 0x0f) | 0x40
      bytes[8] = (bytes[8]! & 0x3f) | 0x80

      const hex: string[] = []
      for (const byte of bytes) hex.push(byte.toString(16).padStart(2, '0'))

      return (
        hex.slice(0, 4).join('') +
        '-' +
        hex.slice(4, 6).join('') +
        '-' +
        hex.slice(6, 8).join('') +
        '-' +
        hex.slice(8, 10).join('') +
        '-' +
        hex.slice(10, 16).join('')
      )
    }

    throw new Error(
      'CryptoIdGenerator requires a secure random source (crypto.randomUUID or ' +
        'crypto.getRandomValues). Refusing to fall back to Math.random for financial ' +
        'record identifiers.'
    )
  }

  /** Whether this environment can produce secure identifiers. Useful for diagnostics. */
  static isSupported(): boolean {
    const crypto = platformCrypto()
    return typeof crypto?.randomUUID === 'function' || typeof crypto?.getRandomValues === 'function'
  }
}
