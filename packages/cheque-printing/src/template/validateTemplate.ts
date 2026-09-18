/**
 * Template validation — the gate between "a JSON blob someone drew in the designer" and
 * "geometry we are willing to put toner on".
 *
 * Errors are things that would misprint a physical instrument or violate the architecture rules;
 * they block publishing and block printing. Warnings are judgement calls an operator can accept.
 * Every issue carries a `remediation`, because this same object is what the designer UI renders.
 */

import { isPhysicalExtent, rectContains, roundMm, type MmRect } from '../geometry/units'
import { bodyRectOnSheet, fieldRectOnSheet, sheetRect } from './geometry'
import { TemplateValidationError, type PrintingIssue } from '../errors'
import {
  CUSTOM_FIELD_KEY_PATTERN,
  FORBIDDEN_HINT_KEYS,
  KNOWN_CHEQUE_FIELD_KEYS,
  NEVER_PRINTED_ROLES,
  PREPRINTED_SUPPRESSIONS,
  TEMPLATE_FORMATS,
  TEMPLATE_UNIT,
  isKnownFieldKey,
  type BankChequeTemplate,
  type FieldRole,
  type TemplateField,
} from './types'

/** A field shorter than this cannot physically contain a line of text at any usable size. */
const MIN_PRINTABLE_HEIGHT_MM = 2
const MIN_PRINTABLE_WIDTH_MM = 2
const MM_TOLERANCE = 0.05
/** Anything finer than a micron is below the mechanical resolution of a laser printer. */
const SUB_MICRON_EPSILON = 1e-6

export interface TemplateValidationReport {
  readonly ok: boolean
  readonly issues: readonly PrintingIssue[]
  readonly errors: readonly PrintingIssue[]
  readonly warnings: readonly PrintingIssue[]
}

export interface ValidateTemplateOptions {
  /** Warn instead of ignore when a template has no printed fields at all (e.g. a draft). */
  readonly allowEmpty?: boolean
}

export function validateTemplate(
  template: BankChequeTemplate,
  options: ValidateTemplateOptions = {}
): TemplateValidationReport {
  const issues: PrintingIssue[] = []
  const push = (issue: PrintingIssue) => issues.push(issue)
  const at = (fieldId: string) => ({ fieldId, templateId: template.id })

  if (template.unit !== TEMPLATE_UNIT) {
    push({
      code: 'TEMPLATE_UNIT_MUST_BE_MM',
      severity: 'error',
      message: `template unit must be "mm" (rule T1), got "${String(template.unit)}"`,
      remediation: 'express geometry in millimetres; pixels are not a print unit',
      templateId: template.id,
    })
  }

  validateIdentity(template, push)
  validatePaper(template, push)
  validateFields(template, push, at)
  validatePreprintedConsistency(template, push, at)
  validatePrinterHintIndependence(template, push)

  const errors = issues.filter((issue) => issue.severity === 'error')
  const warnings = issues.filter((issue) => issue.severity === 'warning')

  const printedCount = template.fields.filter((field) => field.isPrinted).length
  if (printedCount === 0 && options.allowEmpty !== true) {
    warnings.push({
      code: 'NO_PRINTED_FIELDS',
      severity: 'warning',
      message: 'this template prints nothing — every field is a preview-only guide',
      remediation: 'mark at least the payee, amount and date fields as printed',
      templateId: template.id,
    })
  }

  return {
    ok: errors.length === 0,
    issues,
    errors,
    warnings,
  }
}

function validateIdentity(template: BankChequeTemplate, push: (issue: PrintingIssue) => void): void {
  for (const key of ['id', 'bankId', 'bankName', 'name', 'stockType'] as const) {
    const value = template[key]
    if (typeof value !== 'string' || value.trim() === '') {
      push({
        code: 'TEMPLATE_IDENTITY_INCOMPLETE',
        severity: 'error',
        message: `template.${key} is required — an anonymous template cannot be attributed in a print record`,
        remediation: `set ${key}`,
        templateId: template.id,
      })
    }
  }
  if (!Number.isSafeInteger(template.version) || template.version < 1) {
    push({
      code: 'TEMPLATE_VERSION_INVALID',
      severity: 'error',
      message: `template.version must be an integer >= 1 (rule T4), got ${String(template.version)}`,
      remediation: 'publish a new version instead of editing a released one',
      templateId: template.id,
    })
  }
}

function validatePaper(template: BankChequeTemplate, push: (issue: PrintingIssue) => void): void {
  const { paper } = template
  const checks: readonly (readonly [string, number])[] = [
    ['paper.widthMm', paper.widthMm],
    ['paper.heightMm', paper.heightMm],
    ['paper.bodyWidthMm', paper.bodyWidthMm],
    ['paper.bodyHeightMm', paper.bodyHeightMm],
    ['paper.bodyOriginMm.xMm', paper.bodyOriginMm.xMm],
    ['paper.bodyOriginMm.yMm', paper.bodyOriginMm.yMm],
  ]
  for (const [label, value] of checks) {
    if (!Number.isFinite(value)) {
      push({
        code: 'PAPER_GEOMETRY_NOT_FINITE',
        severity: 'error',
        message: `${label} must be a finite number in millimetres, got ${String(value)}`,
        remediation: 'enter a numeric millimetre value',
        templateId: template.id,
      })
      continue
    }
    const mustBePositive = label !== 'paper.bodyOriginMm.xMm' && label !== 'paper.bodyOriginMm.yMm'
    if (mustBePositive && value <= 0) {
      push({
        code: 'PAPER_DIMENSION_NON_POSITIVE',
        severity: 'error',
        message: `${label} must be a positive millimetre value, got ${String(value)}`,
        remediation: 'measure the stock with a ruler and re-enter it',
        templateId: template.id,
      })
    }
    if (!mustBePositive && value < 0) {
      push({
        code: 'BODY_ORIGIN_NEGATIVE',
        severity: 'error',
        message: `${label} cannot be negative — the body cannot start before the sheet edge`,
        remediation: 'set the offset to 0 for a full-sheet stock',
        templateId: template.id,
      })
    }
  }

  const landscape = paper.widthMm > paper.heightMm
  if (paper.orientation === 'landscape' && !landscape && paper.widthMm !== paper.heightMm) {
    push({
      code: 'PAPER_ORIENTATION_MISMATCH',
      severity: 'warning',
      message: `orientation is "landscape" but width (${String(paper.widthMm)}mm) is not greater than height (${String(paper.heightMm)}mm)`,
      remediation: 'swap the dimensions or set orientation to portrait',
      templateId: template.id,
    })
  }
  if (paper.orientation === 'portrait' && landscape) {
    push({
      code: 'PAPER_ORIENTATION_MISMATCH',
      severity: 'warning',
      message: 'orientation is "portrait" but the sheet is wider than it is tall',
      remediation: 'swap the dimensions or set orientation to landscape',
      templateId: template.id,
    })
  }

  const body: MmRect = {
    xMm: paper.bodyOriginMm.xMm,
    yMm: paper.bodyOriginMm.yMm,
    widthMm: paper.bodyWidthMm,
    heightMm: paper.bodyHeightMm,
  }
  const sheet: MmRect = { xMm: 0, yMm: 0, widthMm: paper.widthMm, heightMm: paper.heightMm }
  if (!rectContains(sheet, body, MM_TOLERANCE)) {
    push({
      code: 'BODY_OUTSIDE_PAPER',
      severity: 'error',
      message: 'the cheque body does not fit inside the sheet — printing would clip or misfeed',
      remediation: 'reduce body width/height or move bodyOriginMm inside the sheet',
      templateId: template.id,
    })
  }

  if (!isPhysicalExtent(paper.widthMm) || !isPhysicalExtent(paper.heightMm)) {
    push({
      code: 'PAPER_DIMENSIONS_UNREALISTIC',
      severity: 'error',
      message: `paper size ${String(paper.widthMm)} x ${String(paper.heightMm)} mm is outside the physical range this engine supports (0.5–5000mm)`,
      remediation: 'measure the stock with a ruler and re-enter it',
      templateId: template.id,
    })
  }
}

function validateFields(
  template: BankChequeTemplate,
  push: (issue: PrintingIssue) => void,
  at: (fieldId: string) => { fieldId: string; templateId: string }
): void {
  if (template.fields.length === 0) {
    push({
      code: 'NO_FIELDS',
      severity: 'error',
      message: 'a template with no fields cannot produce a layout',
      remediation: 'add at least the payee, amount and date fields',
      templateId: template.id,
    })
    return
  }

  const ids = new Set<string>()
  const keyRole = new Set<string>()
  const knownKeys = new Set<string>(KNOWN_CHEQUE_FIELD_KEYS)

  for (const field of template.fields) {
    validateFieldIdentity(field, template, ids, keyRole, knownKeys, push, at)
    validateFieldGeometry(field, template, push, at)
    validateFieldTypography(field, push, at)
    validateFieldMapping(field, template, push, at)
    validateMicrPolicy(field, template, push, at)
  }
}

function validateFieldIdentity(
  field: TemplateField,
  template: BankChequeTemplate,
  ids: Set<string>,
  keyRole: Set<string>,
  knownKeys: Set<string>,
  push: (issue: PrintingIssue) => void,
  at: (fieldId: string) => { fieldId: string; templateId: string }
): void {
  if (typeof field.id !== 'string' || field.id.trim() === '') {
    push({
      code: 'FIELD_ID_MISSING',
      severity: 'error',
      message: 'every field needs a stable id — print records and calibration reference fields by id',
      remediation: 'give the field an id',
      templateId: template.id,
    })
  } else if (ids.has(field.id)) {
    push({
      code: 'FIELD_ID_DUPLICATE',
      severity: 'error',
      ...at(field.id),
      message: `duplicate field id "${field.id}"`,
      remediation: 'ids must be unique inside one template',
    })
  } else {
    ids.add(field.id)
  }

  if (!knownKeys.has(field.key) && !CUSTOM_FIELD_KEY_PATTERN.test(field.key)) {
    push({
      code: 'FIELD_KEY_INVALID',
      severity: 'error',
      ...at(field.id),
      message: `custom field key "${field.key}" must be lower-case with single hyphens (e.g. "branch-code")`,
      remediation: 'rename the key, or use one of the canonical keys',
      templateId: template.id,
    })
  }
  if (field.isPrinted && field.key === 'micr' && field.source === undefined) {
    // 'micr' has no data source by design: there is no MICR encoder in this phase. A preview-only
    // guide (isPrinted: false) is legal and expected — the bank prints that band, not us.
    push({
      code: 'MICR_ENCODING_NOT_IMPLEMENTED',
      severity: 'error',
      ...at(field.id),
      message: 'the MICR band cannot be a printed data field — MICR encoding is out of scope for this phase (§9)',
      remediation: 'set the field to isPrinted: false to keep it as a preview guide only',
      templateId: template.id,
    })
  }

  const combination = `${field.key}::${field.role}`
  if (keyRole.has(combination)) {
    push({
      code: 'FIELD_KEY_ROLE_DUPLICATE',
      severity: 'warning',
      ...at(field.id),
      message: `more than one printed field binds "${field.key}" as "${field.role}" — the second will overwrite it visually`,
      remediation: 'delete the duplicate or change its role',
      templateId: template.id,
    })
  }
  keyRole.add(combination)

  if (typeof field.label !== 'string' || field.label.trim() === '') {
    push({
      code: 'FIELD_LABEL_MISSING',
      severity: 'warning',
      ...at(field.id),
      message: 'a field without a label is unmaintainable in the designer',
      remediation: 'add a human-readable label',
      templateId: template.id,
    })
  }
}

function validateFieldGeometry(
  field: TemplateField,
  template: BankChequeTemplate,
  push: (issue: PrintingIssue) => void,
  at: (fieldId: string) => { fieldId: string; templateId: string }
): void {
  const values: readonly (readonly [string, number])[] = [
    ['xMm', field.xMm],
    ['yMm', field.yMm],
    ['widthMm', field.widthMm],
    ['heightMm', field.heightMm],
  ]
  let finite = true
  for (const [label, value] of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      finite = false
      push({
        code: 'FIELD_GEOMETRY_NOT_FINITE',
        severity: 'error',
        ...at(field.id),
        message: `field "${field.id}" ${label} must be a finite millimetre number, got ${String(value)}`,
        remediation: 'enter a number; this engine has no pixel or "auto" geometry',
        templateId: template.id,
      })
    }
  }
  if (!finite) return

  if (field.widthMm <= 0 || field.heightMm <= 0) {
    push({
      code: 'FIELD_DIMENSION_NON_POSITIVE',
      severity: 'error',
      ...at(field.id),
      message: `field "${field.id}" must have positive width and height`,
      remediation: 'a zero-size field cannot receive text',
      templateId: template.id,
    })
  } else if (field.isPrinted && (field.widthMm < MIN_PRINTABLE_WIDTH_MM || field.heightMm < MIN_PRINTABLE_HEIGHT_MM)) {
    push({
      code: 'FIELD_TOO_SMALL',
      severity: 'error',
      ...at(field.id),
      message: `field "${field.id}" is ${String(field.widthMm)} x ${String(field.heightMm)}mm — too small to hold a line of type`,
      remediation: `use at least ${String(MIN_PRINTABLE_WIDTH_MM)} x ${String(MIN_PRINTABLE_HEIGHT_MM)}mm`,
      templateId: template.id,
    })
  }

  // `createTemplateField` rounds, so this only fires for a template that was hand-edited or
  // imported from another tool. It is a warning, not an error: the engine prints the rounded
  // value, and the author deserves to know a fraction of a micron was dropped on the way in.
  for (const [precisionLabel, precisionValue] of values) {
    if (typeof precisionValue !== 'number' || !Number.isFinite(precisionValue)) continue
    if (Math.abs(roundMm(precisionValue) - precisionValue) > SUB_MICRON_EPSILON) {
      push({
        code: 'FIELD_GEOMETRY_SUB_MICRON',
        severity: 'warning',
        ...at(field.id),
        message: `field "${field.id}" ${precisionLabel} = ${String(precisionValue)} is finer than the engine prints (1 micron); it becomes ${String(roundMm(precisionValue))}`,
        remediation: 'round the value',
        templateId: template.id,
      })
    }
  }

  // Field coordinates are body-relative (see template/geometry.ts), so both bounds checks have to
  // be done on the sheet rectangle the engine will actually print into.
  const body: MmRect = bodyRectOnSheet(template)
  const fieldRect: MmRect = fieldRectOnSheet(template, field)
  const sheet = sheetRect(template)
  if (!rectContains(sheet, fieldRect, MM_TOLERANCE)) {
    push({
      code: 'FIELD_OUTSIDE_PAPER',
      severity: 'error',
      ...at(field.id),
      message: `field "${field.id}" falls off the sheet — it would print on the next cheque of the strip or not at all`,
      remediation: 'move it inside the paper bounds',
      templateId: template.id,
    })
  } else if (!rectContains(body, fieldRect, MM_TOLERANCE) && field.isPrinted) {
    push({
      code: 'FIELD_OUTSIDE_BODY',
      severity: 'warning',
      ...at(field.id),
      message: `field "${field.id}" sits outside the declared cheque body`,
      remediation: 'usually fine for a counterfoil stub; confirm it is intentional',
      templateId: template.id,
    })
  }

  if (field.rotationDeg !== undefined) {
    const rotation = field.rotationDeg
    if (!Number.isFinite(rotation) || rotation < 0 || rotation >= 360) {
      push({
        code: 'FIELD_ROTATION_INVALID',
        severity: 'error',
        ...at(field.id),
        message: `rotationDeg must be in [0, 360), got ${String(rotation)}`,
        remediation: 'express rotation as a positive angle less than a full turn',
        templateId: template.id,
      })
    }
  }
}

function validateFieldTypography(
  field: TemplateField,
  push: (issue: PrintingIssue) => void,
  at: (fieldId: string) => { fieldId: string; templateId: string }
): void {
  const { typography } = field
  if (typeof typography.fontFamily !== 'string' || typography.fontFamily.trim() === '') {
    push({
      code: 'FIELD_FONT_MISSING',
      severity: 'error',
      ...at(field.id),
      message: `field "${field.id}" has no font family — the printer would substitute whatever it likes`,
      remediation: 'name a font that exists on the target printer, or embed it in the document',
    })
  }
  if (!Number.isFinite(typography.fontSizePt) || typography.fontSizePt <= 0) {
    push({
      code: 'FIELD_FONT_SIZE_INVALID',
      severity: 'error',
      ...at(field.id),
      message: `field "${field.id}" fontSizePt must be a positive number of points`,
      remediation: 'use 8–14pt for cheque data; points, never pixels',
    })
  }
  if (!Number.isFinite(typography.fontWeight) || typography.fontWeight < 100 || typography.fontWeight > 900) {
    push({
      code: 'FIELD_FONT_WEIGHT_INVALID',
      severity: 'warning',
      ...at(field.id),
      message: `field "${field.id}" fontWeight ${String(typography.fontWeight)} is outside 100–900`,
      remediation: 'use a CSS numeric weight',
    })
  }
  if (typography.letterSpacingPt !== undefined && !Number.isFinite(typography.letterSpacingPt)) {
    push({
      code: 'FIELD_LETTER_SPACING_INVALID',
      severity: 'error',
      ...at(field.id),
      message: 'letterSpacingPt must be a finite number of points',
      remediation: 'remove it or set a number',
    })
  }
  if (typography.lineHeight !== undefined && (typography.lineHeight < 0.8 || typography.lineHeight > 3)) {
    push({
      code: 'FIELD_LINE_HEIGHT_UNREALISTIC',
      severity: 'warning',
      ...at(field.id),
      message: `lineHeight ${String(typography.lineHeight)} is outside the sane wrap range (0.8–3)`,
      remediation: 'check the value; wrapped lines may overlap on paper',
    })
  }
  if (field.overflow !== 'shrink' && field.overflow !== 'wrap' && field.overflow !== 'clip' && field.overflow !== 'error') {
    push({
      code: 'FIELD_OVERFLOW_POLICY_INVALID',
      severity: 'error',
      ...at(field.id),
      message: `unknown overflow policy "${String(field.overflow)}"`,
      remediation: 'use shrink, wrap, clip or error',
    })
  }
  if (field.maxChars !== undefined && (!Number.isSafeInteger(field.maxChars) || field.maxChars <= 0)) {
    push({
      code: 'FIELD_MAX_CHARS_INVALID',
      severity: 'error',
      ...at(field.id),
      message: 'maxChars must be a positive integer',
      remediation: 'remove it or set a character count',
    })
  }
  if (!Number.isSafeInteger(field.zIndex)) {
    push({
      code: 'FIELD_Z_INDEX_NOT_INTEGER',
      severity: 'warning',
      ...at(field.id),
      message: `zIndex ${String(field.zIndex)} is not an integer; run ordering is still deterministic but the designer will show it rounded`,
      remediation: 'use whole numbers',
    })
  }
}

function validateFieldMapping(
  field: TemplateField,
  template: BankChequeTemplate,
  push: (issue: PrintingIssue) => void,
  at: (fieldId: string) => { fieldId: string; templateId: string }
): void {
  if (field.format !== undefined && !(TEMPLATE_FORMATS as readonly string[]).includes(field.format)) {
    push({
      code: 'FIELD_FORMAT_UNKNOWN',
      severity: 'error',
      ...at(field.id),
      message: `unknown format "${String(field.format)}"`,
      remediation: `supported: ${TEMPLATE_FORMATS.join(', ')}`,
      templateId: template.id,
    })
  }
  if (field.source === 'custom' && (field.customKey === undefined || field.customKey.trim() === '')) {
    push({
      code: 'FIELD_CUSTOM_SOURCE_MISSING_KEY',
      severity: 'error',
      ...at(field.id),
      message: 'a field mapped to the custom source must name a customKey',
      remediation: 'set customKey to the property name in the print data',
      templateId: template.id,
    })
  }
  if (!isKnownFieldKey(field.key) && field.source === undefined) {
    push({
      code: 'FIELD_CUSTOM_SOURCE_REQUIRED',
      severity: 'error',
      ...at(field.id),
      message: `custom field "${field.key}" has no data source and cannot be resolved`,
      remediation: 'set source (and customKey when source is "custom")',
      templateId: template.id,
    })
  }
  if (
    (field.format === 'amount-words-en' || field.format === 'amount-words-ar') &&
    field.source !== undefined &&
    field.source !== 'amountWords' &&
    field.source !== 'amountDecimal'
  ) {
    push({
      code: 'FIELD_WORDS_SOURCE_MISMATCH',
      severity: 'error',
      ...at(field.id),
      message: `a words format must read from amountWords or amountDecimal, not "${field.source}"`,
      remediation: 'change the source, or drop the words format',
      templateId: template.id,
    })
  }
  if (field.required === true && !field.isPrinted) {
    push({
      code: 'FIELD_REQUIRED_BUT_NOT_PRINTED',
      severity: 'warning',
      ...at(field.id),
      message: `field "${field.id}" is required but is preview-only, so the requirement cannot be enforced on paper`,
      remediation: 'either print it or mark it optional',
      templateId: template.id,
    })
  }
  if (template.defaultDirection === 'rtl' && field.typography.direction === 'ltr' && field.key === 'payee') {
    push({
      code: 'FIELD_DIRECTION_SUSPECT',
      severity: 'warning',
      ...at(field.id),
      message: 'an RTL stock with a hard-LTR payee field is unusual — Arabic payees will right-align but render LTR',
      remediation: 'use direction "auto" or "rtl" for Arabic payees',
      templateId: template.id,
    })
  }
}

/** T2/T3 and the MICR exclusion. */
function validateMicrPolicy(
  field: TemplateField,
  template: BankChequeTemplate,
  push: (issue: PrintingIssue) => void,
  at: (fieldId: string) => { fieldId: string; templateId: string }
): void {
  if (field.isPrinted && (NEVER_PRINTED_ROLES as readonly FieldRole[]).includes(field.role)) {
    push({
      code: 'ARTWORK_NOT_ALLOWED',
      severity: 'error',
      ...at(field.id),
      message: `a template may not print "${field.role}" content (rule T2) — "${field.label}" belongs to the bank's stock`,
      remediation: 'set isPrinted: false to keep it as a preview guide, or delete the field',
      templateId: template.id,
    })
  }
  if (field.typography.isMicr && field.isPrinted) {
    push({
      code: 'MICR_ENCODING_NOT_IMPLEMENTED',
      severity: 'error',
      ...at(field.id),
      message: 'MICR output is not implemented in this phase; a MICR-flagged field cannot be printed',
      remediation: 'keep the MICR band as a preview-only guide (isPrinted: false) — §9',
      templateId: template.id,
    })
  }
}

/** Every suppression rule that fires on this template should be reported as a fact, not a surprise. */
function validatePreprintedConsistency(
  template: BankChequeTemplate,
  push: (issue: PrintingIssue) => void,
  at: (fieldId: string) => { fieldId: string; templateId: string }
): void {
  for (const field of template.fields) {
    if (!field.isPrinted) continue
    const suppressed = PREPRINTED_SUPPRESSIONS.find(
      (rule) =>
        template.preprinted[rule.flag] &&
        (rule.keys.length === 0 || rule.keys.includes(field.key)) &&
        rule.roles.includes(field.role)
    )
    if (suppressed !== undefined) {
      push({
        code: 'FIELD_SUPPRESSED_BY_PREPRINTED',
        severity: 'warning',
        ...at(field.id),
        message: `field "${field.id}" will not be printed: ${suppressed.reason}`,
        remediation: 'expected for pre-printed stock; delete the field if it is noise',
        templateId: template.id,
      })
    }
  }
}

/** T7: a template carries no device geometry. */
function validatePrinterHintIndependence(
  template: BankChequeTemplate,
  push: (issue: PrintingIssue) => void
): void {
  const hint = template.printerConfigHint
  if (hint === undefined) return
  const record = hint as Record<string, unknown>
  for (const key of FORBIDDEN_HINT_KEYS) {
    if (key in record) {
      push({
        code: 'PRINTER_HINT_GEOMETRY_FORBIDDEN',
        severity: 'error',
        templateId: template.id,
        message: `printerConfigHint may not carry "${key}" (rule T7) — offsets and scaling belong to the printer profile and its calibration`,
        remediation: 'move it to the PrinterProfile, then calibrate per printer+stock',
      })
    }
  }
}

export function collectIssues(report: TemplateValidationReport): string[] {
  return report.issues.map((issue) => `${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`)
}

export function assertTemplateValid(
  template: BankChequeTemplate,
  options: ValidateTemplateOptions = {}
): TemplateValidationReport {
  const report = validateTemplate(template, options)
  if (!report.ok) {
    throw new TemplateValidationError(template.name, report.errors)
  }
  return report
}

/**
 * Draft validation for the designer: accepts a partial, possibly invalid object and reports the
 * problems without throwing. Uses runtime checks only, so a half-typed template never crashes UI.
 */
export function describeTemplateGeometry(template: BankChequeTemplate): string[] {
  const lines: string[] = [
    `sheet ${String(template.paper.widthMm)} x ${String(template.paper.heightMm)} mm (${template.paper.orientation})`,
    `body ${String(template.paper.bodyWidthMm)} x ${String(template.paper.bodyHeightMm)} mm at (${String(template.paper.bodyOriginMm.xMm)}, ${String(template.paper.bodyOriginMm.yMm)})`,
  ]
  for (const field of template.fields) {
    lines.push(
      `  ${field.id} ${field.key}/${field.role} @ ${String(field.xMm)},${String(field.yMm)} ${String(field.widthMm)}x${String(field.heightMm)} ${String(field.typography.fontSizePt)}pt ${field.isPrinted ? '' : '(guide)'}`.replace(
        /\s+$/,
        ''
      )
    )
  }
  return lines
}
