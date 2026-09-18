import type { PrintingRecordStore } from '../ports/recordStore'

/**
 * In-memory record store: the reference adapter for tests, for a Node backend, and as the fallback
 * when a deployment has no durable storage. Round-trips through JSON so it has exactly the same
 * "only what serialises, survives" behaviour as the real adapters — a `Map`, a `Symbol` or a
 * function in a record fails here just as it would in localStorage, instead of silently working in
 * tests and breaking in production.
 */
export class InMemoryPrintingRecordStore implements PrintingRecordStore {
  private readonly records = new Map<string, string>()

  async get<T = unknown>(key: string): Promise<T | null> {
    const raw = this.records.get(key)
    if (raw === undefined) return null
    return JSON.parse(raw) as T
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    this.records.set(key, JSON.stringify(value))
  }

  async remove(key: string): Promise<void> {
    this.records.delete(key)
  }

  async keys(): Promise<string[]> {
    return [...this.records.keys()].sort()
  }

  /** Test/debug view: the raw serialised map, sorted for stable assertions. */
  snapshot(): Readonly<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const key of [...this.records.keys()].sort()) {
      const value = this.records.get(key)
      if (value !== undefined) out[key] = value
    }
    return out
  }

  get size(): number {
    return this.records.size
  }

  clear(): void {
    this.records.clear()
  }
}
