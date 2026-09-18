/**
 * Template registry — an in-memory index of published versions.
 *
 * The registry is the persistence-agnostic half of template management: it validates on publish
 * and refuses to overwrite a released version. Storage (encrypted localStorage today, IndexedDB
 * later) is the application's job and goes through the `TemplateRepository` port, so this class
 * has no I/O, no clock and no framework.
 */

import { TemplateValidationError, type PrintingIssue } from '../errors'
import { computeTemplateHash, withActiveState } from './BankChequeTemplate'
import { validateTemplate, type TemplateValidationReport } from './validateTemplate'
import type { BankChequeTemplate } from './types'

export interface TemplateRegistryOptions {
  /** Default true. A registry that accepts invalid geometry would defeat the publish gate. */
  readonly validateOnPublish?: boolean
  /**
   * Lets the host declare "this version has been printed, do not remove it". The registry does
   * not track jobs itself — that would duplicate the print-record store.
   */
  readonly isVersionReferenced?: (templateId: string, version: number) => boolean
}

export interface PublishReport {
  readonly template: BankChequeTemplate
  readonly validation: TemplateValidationReport
  readonly createdVersion: number
  /** True when an identical hash was already published, so no new version was needed. */
  readonly alreadyPublished: boolean
}

export class TemplateRegistry {
  private readonly byId = new Map<string, Map<number, BankChequeTemplate>>()
  private readonly options: Required<Omit<TemplateRegistryOptions, 'isVersionReferenced'>> & {
    isVersionReferenced?: (templateId: string, version: number) => boolean
  }

  constructor(options: TemplateRegistryOptions = {}) {
    this.options = {
      validateOnPublish: options.validateOnPublish ?? true,
      ...(options.isVersionReferenced === undefined
        ? {}
        : { isVersionReferenced: options.isVersionReferenced }),
    }
  }

  get size(): number {
    let total = 0
    for (const versions of this.byId.values()) total += versions.size
    return total
  }

  /**
   * Publish a template. Re-publishing byte-identical content is a no-op that reports the existing
   * version; publishing changed content at a version that already exists is refused, because a
   * silent edit would invalidate every print record that pinned it (T4, A4).
   */
  publish(template: BankChequeTemplate): PublishReport {
    const validation = validateTemplate(template, { allowEmpty: true })
    if (this.options.validateOnPublish && !validation.ok) {
      throw new TemplateValidationError(template.name, validation.errors)
    }

    const versions = this.byId.get(template.id) ?? new Map<number, BankChequeTemplate>()
    const existing = versions.get(template.version) ?? null
    if (existing !== null) {
      if (existing.templateHash === template.templateHash) {
        return {
          template: existing,
          validation,
          createdVersion: existing.version,
          alreadyPublished: true,
        }
      }
      throw new Error(
        `template "${template.id}" version ${String(template.version)} is already published ` +
          `with different content (hash ${existing.templateHash} vs ${template.templateHash}). ` +
          `Publish version ${String(template.version + 1)} instead — released layouts are immutable.`
      )
    }

    const recomputed = computeTemplateHash(template)
    if (recomputed !== template.templateHash) {
      throw new Error(
        `template "${template.id}" carries a stale templateHash (${template.templateHash}); ` +
          `recomputed ${recomputed}. Do not hand-edit a published layout — publish a new version.`
      )
    }

    versions.set(template.version, template)
    this.byId.set(template.id, versions)
    return { template, validation, createdVersion: template.version, alreadyPublished: false }
  }

  get(templateId: string, version?: number): BankChequeTemplate | null {
    const versions = this.byId.get(templateId)
    if (versions === undefined) return null
    if (version !== undefined) return versions.get(version) ?? null
    return this.latest(templateId)
  }

  latest(templateId: string): BankChequeTemplate | null {
    const versions = this.byId.get(templateId)
    if (versions === undefined || versions.size === 0) return null
    let newest: BankChequeTemplate | null = null
    for (const template of versions.values()) {
      if (newest === null || template.version > newest.version) newest = template
    }
    return newest
  }

  /**
   * Resolve a version a job pinned. An exact hit is returned as-is; a missing version throws with
   * the versions that do exist, because "silently print the latest layout for an old job" is
   * precisely the failure a reprint must never have.
   */
  resolvePinned(templateId: string, version: number): BankChequeTemplate {
    const template = this.get(templateId, version)
    if (template !== null) return template
    const available = this.listVersions(templateId)
    if (available.length === 0) {
      throw new Error(`template "${templateId}" is not published (known ids: ${this.ids().join(', ') || 'none'})`)
    }
    throw new Error(
      `template "${templateId}" has no version ${String(version)} (published: ${available
        .map((v) => `v${String(v)}`)
        .join(', ')}) — the layout a job pins must remain resolvable for reprints`
    )
  }

  listVersions(templateId: string): number[] {
    const versions = this.byId.get(templateId)
    if (versions === undefined) return []
    return [...versions.keys()].sort((a, b) => a - b)
  }

  ids(): string[] {
    return [...this.byId.keys()].sort()
  }

  all(): BankChequeTemplate[] {
    const out: BankChequeTemplate[] = []
    for (const templateId of this.ids()) {
      const versions = this.byId.get(templateId)
      if (versions === undefined) continue
      for (const version of [...versions.keys()].sort((a, b) => a - b)) {
        const template = versions.get(version)
        if (template !== undefined) out.push(template)
      }
    }
    return out
  }

  /** Newest version of each id that is active and belongs to `bankId` (when given). */
  findActive(bankId?: string): BankChequeTemplate[] {
    return this.ids()
      .map((id) => this.latest(id))
      .filter((template): template is BankChequeTemplate => template !== null)
      .filter((template) => template.isActive)
      .filter((template) => bankId === undefined || template.bankId === bankId)
      .sort((a, b) => (a.bankId === b.bankId ? a.name.localeCompare(b.name) : a.bankId.localeCompare(b.bankId)))
  }

  findByBank(bankId: string): BankChequeTemplate[] {
    return this.all().filter((template) => template.bankId === bankId)
  }

  /**
   * Find the template a cheque book should use, from its stock reference. Exact string match on
   * the bank's own stock code — this is how "one template per stock design" (T6) is honoured when
   * a bank ships three designs.
   */
  findByStockReference(bankId: string, stockReference: string): BankChequeTemplate | null {
    const wanted = stockReference.trim()
    if (wanted === '') return null
    const matches = this.all().filter(
      (template) =>
        template.bankId === bankId &&
        (template.stockReference ?? '').trim() === wanted &&
        template.isActive
    )
    let newest: BankChequeTemplate | null = null
    for (const candidate of matches) {
      if (newest === null || candidate.version > newest.version) newest = candidate
    }
    return newest
  }

  setActive(templateId: string, version: number, isActive: boolean, at?: string): BankChequeTemplate {
    const current = this.resolvePinned(templateId, version)
    const updated = withActiveState(current, isActive, at)
    const versions = this.byId.get(templateId)
    if (versions === undefined) {
      throw new Error(`template "${templateId}" vanished from the registry`)
    }
    versions.set(version, updated)
    return updated
  }

  /**
   * Remove a version. A version referenced by a print record cannot be removed: the record and the
   * layout it pins must stay mutually resolvable, so deletion is refused rather than cascading.
   */
  remove(templateId: string, version: number): boolean {
    const referenced = this.options.isVersionReferenced?.(templateId, version) ?? false
    if (referenced) {
      throw new Error(
        `template "${templateId}" v${String(version)} is referenced by a print record and cannot be deleted — ` +
          `deactivate it instead (A4: past prints must stay reproducible)`
      )
    }
    const versions = this.byId.get(templateId)
    if (versions === undefined) return false
    const deleted = versions.delete(version)
    if (versions.size === 0) this.byId.delete(templateId)
    return deleted
  }

  /** Publish a batch, reporting per-template issues instead of failing on the first one. */
  publishAll(templates: readonly BankChequeTemplate[]): {
    published: BankChequeTemplate[]
    failures: { readonly templateId: string; readonly issues: readonly PrintingIssue[] }[]
  } {
    const published: BankChequeTemplate[] = []
    const failures: { templateId: string; issues: readonly PrintingIssue[] }[] = []
    for (const template of templates) {
      try {
        const report = this.publish(template)
        published.push(report.template)
      } catch (error) {
        if (error instanceof TemplateValidationError) {
          failures.push({ templateId: template.id, issues: error.errors })
          continue
        }
        throw error
      }
    }
    return { published, failures }
  }

  clear(): void {
    this.byId.clear()
  }
}
