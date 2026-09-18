/**
 * Template construction, normalisation and immutable versioning.
 *
 * A template is data, not a class with hidden state: the app stores it, sends it to a worker,
 * diffs it in the designer and pins a version of it inside a print job. So the API here is a set
 * of pure functions over frozen plain objects, with one important behaviour — publishing does not
 * edit. `nextTemplateVersion()` derives a *new* version, because a print job must be able to say
 * "this came from v3" and reproduce it byte-for-byte years later (T4, A4).
 */

import { hashCanonical } from '../canonical/hash'
import { roundMm } from '../geometry/units'
import {
  TEMPLATE_UNIT,
  type BankChequeTemplate,
  type FieldRole,
  type PreprintedFlags,
  type TemplateField,
  type TemplateFormat,
  type TemplateOrigin,
  type TextDirection,
} from './types'

/**
 * Bookkeeping that must not affect the content hash: timestamps change on every write, and
 * active state is lifecycle rather than geometry — a deactivated copy of a template is still
 * the same layout, so a job pinned to its hash stays reproducible.
 */
const HASH_EXCLUDED_KEYS = ['createdAt', 'updatedAt', 'isActive', 'templateHash'] as const

function hashableContent(template: BankChequeTemplate): Record<string, unknown> {
  const content: Record<string, unknown> = { ...template }
  for (const key of HASH_EXCLUDED_KEYS) {
    delete content[key]
  }
  return content
}

export function computeTemplateHash(
  template: Omit<BankChequeTemplate, 'templateHash'> | BankChequeTemplate
): string {
  return hashCanonical(hashableContent(template as BankChequeTemplate))
}

/**
 * The hash of everything except the version number. Two published versions whose layouts are
 * otherwise identical are the same layout wearing a different label, which is exactly what
 * `nextTemplateVersion` refuses to create.
 */
export function computeLayoutIdentity(template: BankChequeTemplate | Omit<BankChequeTemplate, 'templateHash'>): string {
  const content = hashableContent(template as BankChequeTemplate)
  delete content['version']
  return hashCanonical(content)
}

export const DEFAULT_PREPRINTED: PreprintedFlags = {
  hasPayeeCaption: true,
  hasDateCaption: true,
  hasMemoCaption: true,
  hasAmountBox: true,
  hasDollarsCaption: true,
  hasSignatureCaption: true,
  hasRules: true,
  hasBankArtwork: true,
  hasSecurityBackground: true,
  hasMicrBand: true,
}

export const DEFAULT_TYPOGRAPHY = {
  fontFamily: 'Helvetica',
  fontSizePt: 10,
  fontWeight: 400,
  fontStyle: 'normal' as const,
  lineHeight: 1.15,
  isMicr: false,
  direction: 'auto' as TextDirection,
}

export interface CreateTemplateFieldInput {
  readonly id: string
  readonly key: TemplateField['key']
  readonly label: string
  readonly role?: FieldRole
  readonly xMm: number
  readonly yMm: number
  readonly widthMm: number
  readonly heightMm: number
  readonly fontFamily?: string
  readonly fontSizePt?: number
  readonly fontWeight?: number
  readonly fontStyle?: 'normal' | 'italic'
  readonly letterSpacingPt?: number
  readonly lineHeight?: number
  readonly isMicr?: boolean
  readonly direction?: TextDirection
  readonly fallbackFontFamily?: string
  /** Either the individual edges or the whole alignment object, whichever reads better in a template file. */
  readonly horizontal?: TemplateField['alignment']['horizontal']
  readonly vertical?: TemplateField['alignment']['vertical']
  readonly alignment?: TemplateField['alignment']
  readonly overflow?: TemplateField['overflow']
  readonly maxChars?: number
  readonly textTransform?: 'none' | 'uppercase'
  readonly format?: TemplateFormat
  readonly zIndex?: number
  readonly isPrinted?: boolean
  readonly rotationDeg?: number
  readonly source?: TemplateField['source']
  readonly customKey?: string
  readonly required?: boolean
}

export function createTemplateField(input: CreateTemplateFieldInput): TemplateField {
  const field: TemplateField = {
    id: input.id,
    key: input.key,
    label: input.label,
    role: input.role ?? 'value',
    xMm: roundMm(input.xMm),
    yMm: roundMm(input.yMm),
    widthMm: roundMm(input.widthMm),
    heightMm: roundMm(input.heightMm),
    typography: {
      fontFamily: input.fontFamily ?? DEFAULT_TYPOGRAPHY.fontFamily,
      fontSizePt: input.fontSizePt ?? DEFAULT_TYPOGRAPHY.fontSizePt,
      fontWeight: input.fontWeight ?? DEFAULT_TYPOGRAPHY.fontWeight,
      fontStyle: input.fontStyle ?? DEFAULT_TYPOGRAPHY.fontStyle,
      ...(input.letterSpacingPt === undefined ? {} : { letterSpacingPt: input.letterSpacingPt }),
      lineHeight: input.lineHeight ?? DEFAULT_TYPOGRAPHY.lineHeight,
      isMicr: input.isMicr ?? false,
      direction: input.direction ?? DEFAULT_TYPOGRAPHY.direction,
      ...(input.fallbackFontFamily === undefined
        ? {}
        : { fallbackFontFamily: input.fallbackFontFamily }),
    },
    alignment: {
      horizontal: input.horizontal ?? input.alignment?.horizontal ?? 'left',
      vertical: input.vertical ?? input.alignment?.vertical ?? 'middle',
    },
    overflow: input.overflow ?? 'shrink',
    ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
    ...(input.textTransform === undefined ? {} : { textTransform: input.textTransform }),
    ...(input.format === undefined ? {} : { format: input.format }),
    zIndex: input.zIndex ?? 1,
    isPrinted: input.isPrinted ?? true,
    ...(input.rotationDeg === undefined ? {} : { rotationDeg: input.rotationDeg }),
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.customKey === undefined ? {} : { customKey: input.customKey }),
    ...(input.required === undefined ? {} : { required: input.required }),
  }
  return deepFreeze(field)
}

export interface CreateTemplateInput {
  readonly id: string
  readonly bankId: string
  readonly bankName: string
  readonly name: string
  readonly stockType: string
  readonly stockReference?: string | null
  readonly description?: string | null
  readonly version?: number
  readonly paper: BankChequeTemplate['paper']
  readonly origin?: TemplateOrigin
  readonly fields: readonly (TemplateField | CreateTemplateFieldInput)[]
  readonly preprinted?: Partial<PreprintedFlags>
  readonly defaultDirection?: 'ltr' | 'rtl'
  readonly defaultLocale?: string
  readonly printerConfigHint?: BankChequeTemplate['printerConfigHint']
  readonly isActive?: boolean
  readonly createdAt?: string
  readonly updatedAt?: string
}

/**
 * `createBankChequeTemplate` accepts either a normalised field or the shorthand an author writes,
 * so the discriminator has to look at what only a normalised field has: a resolved `typography`
 * object. (A shorthand input may well carry `overflow` and `alignment` too — that is why testing for
 * those keys would silently pass an unfinished field straight through.)
 */
function isTemplateField(value: TemplateField | CreateTemplateFieldInput): value is TemplateField {
  const candidate = value as TemplateField
  return (
    typeof candidate.overflow === 'string' &&
    typeof candidate.typography?.fontSizePt === 'number' &&
    typeof candidate.typography?.fontFamily === 'string' &&
    candidate.alignment !== undefined &&
    typeof candidate.widthMm === 'number'
  )
}

/**
 * Normalise + freeze a template. Coordinates are rounded to the canonical millimetre precision
 * here, once, so that every downstream consumer (layout, hash, preview) sees identical numbers.
 */
export function createBankChequeTemplate(input: CreateTemplateInput): BankChequeTemplate {
  const now = new Date().toISOString()
  const fields = input.fields.map((field) =>
    isTemplateField(field) ? deepFreeze(cloneField(field)) : createTemplateField(field)
  )

  const withoutHash: Omit<BankChequeTemplate, 'templateHash'> = {
    id: input.id,
    version: input.version ?? 1,
    schemaVersion: 1,
    bankId: input.bankId,
    bankName: input.bankName,
    name: input.name,
    stockType: input.stockType,
    stockReference: input.stockReference ?? null,
    description: input.description ?? null,
    paper: {
      widthMm: roundMm(input.paper.widthMm),
      heightMm: roundMm(input.paper.heightMm),
      orientation: input.paper.orientation,
      bodyOriginMm: {
        xMm: roundMm(input.paper.bodyOriginMm.xMm),
        yMm: roundMm(input.paper.bodyOriginMm.yMm),
      },
      bodyWidthMm: roundMm(input.paper.bodyWidthMm),
      bodyHeightMm: roundMm(input.paper.bodyHeightMm),
    },
    origin: input.origin ?? 'top-left',
    unit: TEMPLATE_UNIT,
    fields,
    preprinted: { ...DEFAULT_PREPRINTED, ...(input.preprinted ?? {}) },
    defaultDirection: input.defaultDirection ?? 'ltr',
    defaultLocale: input.defaultLocale ?? 'en-US',
    ...(input.printerConfigHint === undefined ? {} : { printerConfigHint: input.printerConfigHint }),
    isActive: input.isActive ?? true,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  }

  return deepFreeze({ ...withoutHash, templateHash: computeTemplateHash(withoutHash) })
}

function cloneField(field: TemplateField): TemplateField {
  return { ...field }
}

/**
 * Derive the next version of a published template. The identity stays, the version advances and
 * `createdAt` is carried over — this is the only sanctioned way to change geometry after a
 * version has been used by a print job (T4).
 */
export function nextTemplateVersion(
  previous: BankChequeTemplate,
  changes: Omit<Partial<Pick<BankChequeTemplate, 'name' | 'description' | 'paper' | 'fields' | 'defaultDirection' | 'defaultLocale' | 'printerConfigHint' | 'stockType' | 'stockReference'>>, 'preprinted'> & {
    /** Merged onto the published flags, so an author can flip one bit without restating ten. */
    readonly preprinted?: Partial<BankChequeTemplate['preprinted']>
  },
  options: { readonly createdAt?: string } = {}
): BankChequeTemplate {
  const withoutHash: Omit<BankChequeTemplate, 'templateHash'> = {
    ...previous,
    ...changes,
    preprinted: mergePreprinted(previous.preprinted, changes.preprinted),
    version: previous.version + 1,
    schemaVersion: 1,
    createdAt: options.createdAt ?? previous.createdAt,
    updatedAt: options.createdAt ?? new Date().toISOString(),
    isActive: true,
  }
  const next: BankChequeTemplate = {
    ...withoutHash,
    templateHash: computeTemplateHash(withoutHash),
  }
  if (computeLayoutIdentity(next) === computeLayoutIdentity(previous)) {
    // A version bump that changes nothing would create two interchangeable versions and make
    // pinning meaningless. Refuse it loudly rather than publish a no-op version.
    throw new Error(
      `nextTemplateVersion("${previous.id}") produced no content change — refusing to ` +
        `publish an identical version ${String(next.version)}`
    )
  }
  return deepFreeze(next)
}

/**
 * Merge the flags an author changed onto the published set. Written out rather than spread so that
 * an explicit `undefined` in a patch cannot widen the result back to optional booleans: the layout
 * engine reads these flags on every field.
 */
function mergePreprinted(
  previous: PreprintedFlags,
  changes: Partial<PreprintedFlags> | undefined
): PreprintedFlags {
  if (changes === undefined) return previous
  return {
    hasPayeeCaption: changes.hasPayeeCaption ?? previous.hasPayeeCaption,
    hasDateCaption: changes.hasDateCaption ?? previous.hasDateCaption,
    hasMemoCaption: changes.hasMemoCaption ?? previous.hasMemoCaption,
    hasAmountBox: changes.hasAmountBox ?? previous.hasAmountBox,
    hasDollarsCaption: changes.hasDollarsCaption ?? previous.hasDollarsCaption,
    hasSignatureCaption: changes.hasSignatureCaption ?? previous.hasSignatureCaption,
    hasRules: changes.hasRules ?? previous.hasRules,
    hasBankArtwork: changes.hasBankArtwork ?? previous.hasBankArtwork,
    hasSecurityBackground: changes.hasSecurityBackground ?? previous.hasSecurityBackground,
    hasMicrBand: changes.hasMicrBand ?? previous.hasMicrBand,
  }
}

export function withActiveState(
  template: BankChequeTemplate,
  isActive: boolean,
  at: string = new Date().toISOString()
): BankChequeTemplate {
  return deepFreeze({ ...template, isActive, updatedAt: at })
}

/** Content identity is version-independent of *timestamps*: identical geometry → identical hash. */
export function sameLayoutAs(a: BankChequeTemplate, b: BankChequeTemplate): boolean {
  return a.templateHash === b.templateHash
}

export function printedFields(template: BankChequeTemplate): TemplateField[] {
  return template.fields.filter((field) => field.isPrinted)
}

export function guideFields(template: BankChequeTemplate): TemplateField[] {
  return template.fields.filter((field) => !field.isPrinted)
}

export function findFieldByKey(
  template: BankChequeTemplate,
  key: TemplateField['key'],
  role: FieldRole = 'value'
): TemplateField | null {
  return template.fields.find((field) => field.key === key && field.role === role) ?? null
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    deepFreeze(record[key])
  }
  return Object.freeze(value)
}
