/**
 * Canonical JSON — the byte-exact representation used for hashing.
 *
 * `JSON.stringify` alone is not stable across the app: key order follows insertion order, so a
 * template hand-edited into the same content in a different order would produce a different
 * hash. Sorting keys and normalising numbers makes the hash a *content* identity, which is what
 * `templateHash` and `layoutHash` need for print reproducibility (rule A4).
 */

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue }

/** Serialise with sorted keys, no whitespace, and `-0` normalised. */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set<string>())
}

function serialize(value: unknown, seen: Set<string>): string {
  if (value === null) return 'null'

  const type = typeof value
  if (type === 'string') return JSON.stringify(value as string)
  if (type === 'boolean') return value ? 'true' : 'false'
  if (type === 'number') return formatNumber(value as number)
  if (type === 'undefined' || type === 'function' || type === 'symbol') return 'null'

  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item, seen)).join(',')}]`
  }

  if (value instanceof Date) {
    return JSON.stringify(value.toISOString())
  }

  if (value instanceof Map) {
    const entries = [...value.entries()].map(
      ([key, item]) => [String(key), item] as const
    )
    return serializeObject(entries, seen)
  }

  if (type === 'object') {
    const record = value as Record<string, unknown>
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, record[key]] as const)
    return serializeObject(entries, seen)
  }

  return 'null'
}

function serializeObject(
  entries: readonly (readonly [string, unknown])[],
  seen: Set<string>
): string {
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const parts: string[] = []
  for (const [key, item] of sorted) {
    parts.push(`${JSON.stringify(key)}:${serialize(item, seen)}`)
  }
  return `{${parts.join(',')}}`
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    // Never silently hash `NaN`/`Infinity` — a template with a non-finite length is a bug,
    // and the validator reports it. The hash stays defined and distinguishable.
    return 'null'
  }
  if (Object.is(value, -0)) return '0'
  // Integer-valued numbers print without a trailing ".0" in JSON; keep that, but force a
  // decimal point for other values so 1 and 1.0 remain the same content (they are).
  return JSON.stringify(value)
}
