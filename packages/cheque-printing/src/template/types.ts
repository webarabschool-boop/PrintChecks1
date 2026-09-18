/**
 * Bank cheque template schema — a description of a physical, pre-printed stock form.
 *
 * A template says **where variable data goes on somebody else's artwork**. It is not a cheque
 * design (rule T2): it carries no logo, no security background, no captions and no rules,
 * because those are already on the paper. The `preprinted` block records what the stock already
 * contains so the engine can refuse to print it twice — the defect that Phase 2 exists to fix
 * (docs/ARCHITECTURE.md §7.5).
 *
 * Two refinements on the §7.2 sketch, both needed to make the rules enforceable rather than
 * aspirational:
 *
 * 1. `unit` is a literal `'mm'`, so a `px` value is a *type* error, not a code-review catch.
 * 2. Every field carries a `role`. T3 ("pre-printed content must not be re-printed") cannot be
 *    applied to a bare field key: `hasDateCaption: true` means the word "Date" is on the stock,
 *    while the date *value* still has to be printed. Roles let the engine suppress the caption
 *    and keep the value.
 */

export const TEMPLATE_UNIT = 'mm' as const
export type TemplateUnit = typeof TEMPLATE_UNIT

/** Pixels are not a template unit; anything named like a pixel value is rejected outright. */
export const FORBIDDEN_TEMPLATE_UNITS = ['px', 'pixel', 'pixels', 'pt', 'dpi', 'rem', 'em', '%'] as const

export type PaperOrientation = 'portrait' | 'landscape'
export type TemplateOrigin = 'top-left' | 'bottom-left'

/**
 * The canonical cheque data fields a template can bind to. Custom keys are permitted — see
 * {@link ChequeFieldKey} — because real bank stocks carry fields no generic model predicts
 * (a "CNP" on Romanian cheques, a branch code on some Gulf stocks, a VAT reference on others).
 */
export const KNOWN_CHEQUE_FIELD_KEYS = [
  'payee',
  'amountNumeric',
  'amountWords',
  'date',
  'memo',
  'chequeNumber',
  'signature',
  'drawer',
  'drawerAddress',
  'bankInfo',
  'accountNumber',
  'micr',
] as const

export type KnownChequeFieldKey = (typeof KNOWN_CHEQUE_FIELD_KEYS)[number]

/**
 * A field key. Known keys bind to canonical data automatically; anything else must be a
 * lower-case dashed custom key and must declare an explicit `source`.
 */
export type ChequeFieldKey = KnownChequeFieldKey | (string & {})

export const CUSTOM_FIELD_KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

export function isKnownFieldKey(key: string): key is KnownChequeFieldKey {
  return (KNOWN_CHEQUE_FIELD_KEYS as readonly string[]).includes(key)
}

export type FieldRole = 'value' | 'caption' | 'rule' | 'box' | 'guide' | 'artwork' | 'background'

/** Roles that must never reach the printer: the stock, not the app, owns them (T2). */
export const NEVER_PRINTED_ROLES: readonly FieldRole[] = ['artwork', 'background']

export type HorizontalAlignment = 'left' | 'center' | 'right'
export type VerticalAlignment = 'top' | 'middle' | 'bottom' | 'baseline'
export type OverflowPolicy = 'shrink' | 'wrap' | 'clip' | 'error'
export type TextDirection = 'ltr' | 'rtl' | 'auto'

/**
 * `isMicr` is present so a template can *describe* the bank's pre-printed MICR band, and
 * `true` is only ever legal on a preview-only guide. Phase 2 explicitly excludes MICR
 * encoding; the engine refuses to print a MICR run (docs/ARCHITECTURE.md §9, §16.5).
 */
export interface TemplateTypography {
  readonly fontFamily: string
  /** POINTS, not px — a print-stable absolute unit. */
  readonly fontSizePt: number
  readonly fontWeight: number
  readonly fontStyle: 'normal' | 'italic'
  readonly letterSpacingPt?: number
  /** Multiplier of fontSizePt. Absent → 1.15. */
  readonly lineHeight?: number
  readonly isMicr: boolean
  /**
   * `'auto'` resolves from the field's own content per run, which is what makes a mixed
   * sheet (Arabic payee, Latin account number) work without per-field authoring.
   */
  readonly direction: TextDirection
  readonly fallbackFontFamily?: string
  readonly fontFeatureSettings?: string
}

export interface TemplateAlignment {
  readonly horizontal: HorizontalAlignment
  readonly vertical: VerticalAlignment
}

/**
 * Named data sources a field can be mapped to. This is the field-mapping surface: a template
 * for a stock that prints the payee twice (top and counterfoil stub) simply binds two fields
 * to the same source.
 */
export const CHEQUE_DATA_SOURCES = [
  'chequeNumber',
  'date',
  'payeeName',
  'amountDecimal',
  'amountWords',
  'currency',
  'memo',
  'reference',
  'drawerName',
  'drawerAddress',
  'bankName',
  'accountNumber',
  'signature',
  'custom',
] as const

export type ChequeDataSource = (typeof CHEQUE_DATA_SOURCES)[number]

/** Formats resolved by the layout engine. Amount-in-words goes through the injected port. */
export const TEMPLATE_FORMATS = [
  'text',
  'date-DDMMYYYY',
  'date-DDMMMYYYY',
  'date-YYYYMMDD',
  'amount-2dp',
  'amount-words-en',
  'amount-words-ar',
  'number-padded',
  'uppercase',
] as const

export type TemplateFormat = (typeof TEMPLATE_FORMATS)[number]

export interface TemplateField {
  readonly id: string
  readonly key: ChequeFieldKey
  readonly label: string
  readonly role: FieldRole

  /** Millimetres, measured from the template's own `origin`. */
  readonly xMm: number
  readonly yMm: number
  readonly widthMm: number
  readonly heightMm: number

  readonly typography: TemplateTypography
  readonly alignment: TemplateAlignment
  readonly overflow: OverflowPolicy
  readonly maxChars?: number
  readonly textTransform?: 'none' | 'uppercase'
  readonly format?: TemplateFormat
  readonly zIndex: number

  /** `false` → preview-only guide: drawn on screen, never sent to the printer (T5). */
  readonly isPrinted: boolean

  readonly rotationDeg?: number

  /** Field mapping. Defaults to the canonical source for `key` when omitted. */
  readonly source?: ChequeDataSource
  /** For `source: 'custom'` — the property name inside `ChequePrintData.custom`. */
  readonly customKey?: string

  /** An empty value is a warning; a required empty value on a printed field is an error. */
  readonly required?: boolean
}

export interface PreprintedFlags {
  readonly hasPayeeCaption: boolean
  readonly hasDateCaption: boolean
  readonly hasMemoCaption: boolean
  readonly hasAmountBox: boolean
  readonly hasDollarsCaption: boolean
  readonly hasSignatureCaption: boolean
  readonly hasRules: boolean
  readonly hasBankArtwork: boolean
  readonly hasSecurityBackground: boolean
  readonly hasMicrBand: boolean
}

export const PREPRINTED_FLAG_KEYS = [
  'hasPayeeCaption',
  'hasDateCaption',
  'hasMemoCaption',
  'hasAmountBox',
  'hasDollarsCaption',
  'hasSignatureCaption',
  'hasRules',
  'hasBankArtwork',
  'hasSecurityBackground',
  'hasMicrBand',
] as const satisfies readonly (keyof PreprintedFlags)[]

/**
 * The suppression table behind rule T3. When the flag is set, a printed field matching the
 * key set (empty → any key) and role set is dropped from the layout and reported in
 * `suppressedFields`. Note that no entry ever targets `role: 'value'` for a data field: the
 * caption is the bank's, the data is ours.
 */
export interface PreprintedSuppression {
  readonly flag: keyof PreprintedFlags
  readonly keys: readonly ChequeFieldKey[]
  readonly roles: readonly FieldRole[]
  readonly reason: string
}

export const PREPRINTED_SUPPRESSIONS: readonly PreprintedSuppression[] = [
  {
    flag: 'hasPayeeCaption',
    keys: ['payee'],
    roles: ['caption'],
    reason: 'the "Pay to the order of" caption is pre-printed on the stock',
  },
  {
    flag: 'hasDateCaption',
    keys: ['date'],
    roles: ['caption', 'rule'],
    reason: 'the date caption and its rule are pre-printed on the stock',
  },
  {
    flag: 'hasMemoCaption',
    keys: ['memo'],
    roles: ['caption', 'rule'],
    reason: 'the memo caption and its rule are pre-printed on the stock',
  },
  {
    flag: 'hasAmountBox',
    keys: ['amountNumeric'],
    roles: ['box'],
    reason: 'the amount box is pre-printed; an opaque white box would cover it',
  },
  {
    flag: 'hasDollarsCaption',
    keys: ['amountWords'],
    roles: ['caption', 'rule'],
    reason: 'the "Dollars" caption and its rule are pre-printed on the stock',
  },
  {
    flag: 'hasSignatureCaption',
    keys: ['signature'],
    roles: ['caption', 'rule'],
    reason: 'the signature rule and "Authorized Signature" caption are pre-printed',
  },
  {
    flag: 'hasRules',
    keys: [],
    roles: ['rule'],
    reason: 'all field rules are pre-printed on the stock',
  },
  {
    flag: 'hasBankArtwork',
    keys: [],
    roles: ['artwork'],
    reason: 'bank artwork is on the paper, never in the template',
  },
  {
    flag: 'hasSecurityBackground',
    keys: [],
    roles: ['background'],
    reason: 'the security background is on the paper, never in the template',
  },
  {
    flag: 'hasMicrBand',
    keys: ['micr'],
    roles: ['value', 'guide', 'caption', 'rule'],
    reason: 'the MICR band is printed by the bank / by a MICR device, not by this app (§9)',
  },
]

export interface TemplatePaper {
  /** The physical sheet fed to the printer — a whole voucher strip, not just the cheque. */
  readonly widthMm: number
  readonly heightMm: number
  readonly orientation: PaperOrientation
  /** Where the cheque body sits on that sheet (e.g. the top third of a 3-part voucher). */
  readonly bodyOriginMm: { readonly xMm: number; readonly yMm: number }
  readonly bodyWidthMm: number
  readonly bodyHeightMm: number
}

/**
 * Printer hints, intentionally restricted (rule T7): a template must not carry geometry that
 * belongs to a device. Offsets, scaling and DPI are `PrinterProfile` / calibration concerns and
 * are rejected by the validator if present here.
 */
export interface PrinterConfigHint {
  readonly paperFeed?: 'manual' | 'tray' | 'continuous' | 'sheet'
  readonly trayId?: string
  readonly duplex?: 'none' | 'long-edge' | 'short-edge'
  readonly colourMode?: 'mono' | 'colour'
}

/** Keys that may never appear in a printer hint (T7). */
export const FORBIDDEN_HINT_KEYS = [
  'xOffsetMm',
  'yOffsetMm',
  'scale',
  'scaleX',
  'scaleY',
  'nominalDpi',
  'unprintableMarginMm',
  'skewDeg',
] as const

export interface BankChequeTemplate {
  readonly id: string
  /** Immutable once published; a change creates a new version (T4). */
  readonly version: number
  readonly schemaVersion: 1

  readonly bankId: string
  readonly bankName: string
  readonly name: string
  readonly stockType: string
  readonly stockReference?: string | null
  readonly description?: string | null

  readonly paper: TemplatePaper
  readonly origin: TemplateOrigin
  readonly unit: TemplateUnit

  readonly fields: readonly TemplateField[]
  readonly preprinted: PreprintedFlags

  /** Bidi and amount-in-words default for this stock. */
  readonly defaultDirection: 'ltr' | 'rtl'
  readonly defaultLocale: string

  readonly printerConfigHint?: PrinterConfigHint

  readonly isActive: boolean
  readonly createdAt: string
  readonly updatedAt: string

  /** Content hash, timestamp-independent — what a print job pins alongside `version`. */
  readonly templateHash: string
}
