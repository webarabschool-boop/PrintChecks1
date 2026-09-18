/**
 * Print safety assessment — the gate an operator has to pass before toner moves.
 *
 * The legacy flow was: click print, browser dialog, hope. On pre-printed bank stock a wrong layout is
 * not a wasted page but a ruined negotiable instrument, so the engine computes a `SafetyReport` from
 * everything that is known at that moment — layout warnings, template state and version, calibration
 * existence/freshness/validity, printer profile, physical margins, and the values themselves — and
 * requires an *explicit acknowledgement of the specific warnings being accepted*. Acknowledging a
 * report is not the same as acknowledging "some warnings"; the nonce is computed from the exact code
 * set, so a report that grows a new issue cannot be waved through by a stale confirmation.
 */

import { hashCanonical } from '../canonical/hash'
import { rectsOverlap, type MmRect } from '../geometry/units'
import { PrintBlockedError, type PrintingIssue } from '../errors'
import { validatePrinterCalibration, calibrationFingerprint } from '../printer/calibration'
import { validatePrinterProfile } from '../printer/profile'
import type { PrinterCalibration, PrinterProfile } from '../printer/types'
import type { PrintLayout } from '../layout/types'
import { transformRect } from '../printer/transform'
import type { BankChequeTemplate } from '../template/types'
import type { ChequePrintData } from '../printdata/types'

/** Beyond this, a non-square dot grid cannot be calibrated away. */
const DPI_MISMATCH_BLOCKS_ABOVE = 0.15

export interface PrintPolicy {
  /** Default true: printing uncalibrated must be an explicit, recorded decision (§8.5). */
  readonly requireCalibration: boolean
  /** When true, any warning blocks; when false, warnings need acknowledgement instead. */
  readonly blockOnWarnings: boolean
  readonly allowInactiveTemplate: boolean
  /** A calibration measured long ago is a claim about a machine that may have been serviced. */
  readonly calibrationStaleAfterDays: number | null
  /** Refuse to print a value that exceeds the operator's configured limit without a reason. */
  readonly highAmountDecimal: string | null
  /** The template a job was built from must still match, or the layout is stale. */
  readonly pinTemplateHash: boolean
}

export const DEFAULT_PRINT_POLICY: PrintPolicy = {
  requireCalibration: true,
  blockOnWarnings: false,
  allowInactiveTemplate: false,
  calibrationStaleAfterDays: 90,
  highAmountDecimal: null,
  pinTemplateHash: true,
}

export interface SafetyContext {
  readonly template: BankChequeTemplate
  readonly layout: PrintLayout
  readonly data: ChequePrintData
  readonly profile: PrinterProfile
  readonly calibration: PrinterCalibration | null
  readonly policy?: Partial<PrintPolicy>
  readonly now?: string
  /** Previous jobs for the same cheque number, for a duplicate-print hint. */
  readonly priorAttempts?: number
  readonly isReprint?: boolean
}

export interface SafetyReport {
  readonly ok: boolean
  readonly blocked: boolean
  readonly issues: readonly PrintingIssue[]
  readonly errors: readonly PrintingIssue[]
  readonly warnings: readonly PrintingIssue[]
  /** Codes that an operator must individually tick before the print button unlocks. */
  readonly acknowledgementsRequired: readonly string[]
  readonly requiresConfirmation: boolean
  /** Fingerprint of what this report says. A confirmation is only valid for this exact nonce. */
  readonly nonce: string
  readonly summary: string
}

export interface PrintConfirmation {
  readonly nonce: string
  readonly acknowledged: readonly string[]
  readonly actorId: string
  readonly confirmedAt: string
}

export function assessPrintSafety(context: SafetyContext): SafetyReport {
  const policy: PrintPolicy = { ...DEFAULT_PRINT_POLICY, ...(context.policy ?? {}) }
  const issues: PrintingIssue[] = []
  const add = (issue: PrintingIssue) => issues.push(issue)

  for (const warning of context.layout.warnings) {
    add({
      code: warning.code,
      severity: warning.severity,
      message: warning.message,
      ...(warning.fieldId === undefined ? {} : { fieldId: warning.fieldId }),
      ...(warning.remediation === undefined ? {} : { remediation: warning.remediation }),
      templateId: context.template.id,
    })
  }

  if (!context.template.isActive && !policy.allowInactiveTemplate) {
    add({
      code: 'TEMPLATE_INACTIVE',
      severity: 'error',
      message: `template "${context.template.name}" is deactivated; printing against a retired stock layout is blocked`,
      remediation: 're-activate it deliberately or select the replacement template version',
      templateId: context.template.id,
    })
  }

  if (policy.pinTemplateHash && context.layout.templateHash !== context.template.templateHash) {
    add({
      code: 'TEMPLATE_CHANGED_SINCE_LAYOUT',
      severity: 'error',
      message:
        `the layout was built from template hash ${context.layout.templateHash} but the template now reports ` +
        `${context.template.templateHash}; printing would send geometry that was never previewed`,
      remediation: 'rebuild the layout from the current template and preview it again',
      templateId: context.template.id,
    })
  }

  if (context.layout.templateVersion !== context.template.version) {
    add({
      code: 'TEMPLATE_VERSION_STALE',
      severity: 'error',
      message: `layout pins v${String(context.layout.templateVersion)} while the registry holds v${String(context.template.version)}`,
      remediation: 'a reprint must resolve the pinned version, not the newest one',
      templateId: context.template.id,
    })
  }

  const calibration = context.calibration
  if (calibration === null) {
    add({
      code: 'CALIBRATION_MISSING',
      severity: policy.requireCalibration ? 'error' : 'warning',
      message:
        `no calibration exists for printer "${context.profile.name}" with stock "${context.template.name}". ` +
        `Position will be whatever the profile's nominal offsets imply.`,
      remediation: 'print the registration test page, measure it, store the calibration',
      templateId: context.template.id,
    })
  } else {
    for (const issue of validatePrinterCalibration(calibration)) add(issue)
    if (calibration.templateId !== context.template.id) {
      add({
        code: 'CALIBRATION_WRONG_STOCK',
        severity: 'error',
        message: `calibration ${calibration.id} was measured for "${calibration.templateId}", not "${context.template.id}"`,
        remediation: 'calibration is per (printer, stock) pair — measure this stock',
      })
    }
    if (calibration.templateVersion !== context.template.version) {
      add({
        code: 'CALIBRATION_VERSION_MISMATCH',
        severity: 'error',
        message: `calibration was measured against v${String(calibration.templateVersion)} of this stock, which is now v${String(context.template.version)}`,
        remediation: 're-measure: a template change moves where marks land relative to the bank rules',
      })
    }
    if (policy.calibrationStaleAfterDays !== null && calibration.measuredAt !== '') {
      const days = daysBetween(calibration.measuredAt, context.now ?? new Date().toISOString())
      if (days > policy.calibrationStaleAfterDays) {
        add({
          code: 'CALIBRATION_STALE',
          severity: 'warning',
          message: `the last measurement is ${String(Math.floor(days))} days old (policy: ${String(policy.calibrationStaleAfterDays)})`,
          remediation: 'print a fresh test page, or accept the risk explicitly',
        })
      }
    }
    if (calibration.confidence === 'draft') {
      add({
        code: 'CALIBRATION_DRAFT',
        severity: 'warning',
        message: 'this calibration has not been verified against a second test page',
        remediation: 'print the verification page and mark the calibration verified',
      })
    }
  }

  for (const issue of validatePrinterProfile(context.profile)) add(issue)
  addDeviceCapabilityIssues(context, add)

  addMarginIssues(context, add)
  addAmountIssues(context, policy, add)

  if ((context.priorAttempts ?? 0) > 0 && context.isReprint !== true) {
    add({
      code: 'DUPLICATE_PRINT_SUSPECTED',
      severity: 'warning',
      message: `cheque ${context.data.chequeNumber} has been sent to a printer ${String(context.priorAttempts)} time(s) before`,
      remediation: 'if this is a reprint after a jam or a misprint, cancel it and raise a reprint instead',
    })
  }
  if (context.isReprint === true) {
    add({
      code: 'REPRINT',
      severity: 'warning',
      message: 'this is a reprint: the previous sheet may still be in circulation',
      remediation: 'confirm the ruined sheet was destroyed and that the reason is recorded',
    })
  }

  const errors = issues.filter((issue) => issue.severity === 'error')
  const warnings = issues.filter((issue) => issue.severity === 'warning')
  const blocking = policy.blockOnWarnings ? [...errors, ...warnings] : errors
  const acknowledgementsRequired =
    policy.blockOnWarnings || blocking.length > 0 ? [] : uniqueCodes(warnings)

  const nonce = hashCanonical({
    templateId: context.template.id,
    templateHash: context.template.templateHash,
    layoutHash: context.layout.layoutHash,
    profileId: context.profile.id,
    calibrationFingerprint: calibration === null ? null : calibrationFingerprint(calibration),
    issues: issues.map((issue) => `${issue.severity}:${issue.code}:${issue.fieldId ?? ''}`),
  })

  return Object.freeze({
    ok: blocking.length === 0,
    blocked: blocking.length > 0,
    issues: Object.freeze(issues),
    errors,
    warnings,
    acknowledgementsRequired: Object.freeze(acknowledgementsRequired),
    requiresConfirmation: issues.length > 0,
    nonce,
    summary: summarise(context, errors, warnings, calibration),
  })
}

/**
 * Two things a device can declare that the engine must answer honestly about.
 *
 * `micrTonerCapable` is capability, not a feature: this phase contains no magnetic-ink encoder, so
 * the most a capable printer can be told is that nothing more will happen (rule T5). A non-square
 * DPI, on the other hand, is a real geometry hazard — the print pipeline rounds to dots, and if the
 * horizontal and vertical dot pitch differ, the same millimetre lands at a different offset on each
 * axis. Small differences are the printer's business; a large one is why a calibration would never
 * converge.
 */
function addDeviceCapabilityIssues(context: SafetyContext, add: (issue: PrintingIssue) => void): void {
  const { profile, template } = context
  const stockHasMicrBand =
    template.preprinted.hasMicrBand || template.fields.some((field) => field.typography.isMicr)
  if (stockHasMicrBand) {
    add({
      code: profile.micrTonerCapable ? 'MICR_TONER_DECLARED' : 'MICR_TONER_UNAVAILABLE',
      severity: 'warning',
      message: profile.micrTonerCapable
        ? `${profile.name} declares MICR toner, but this phase emits no MICR encoder: the declared capability changes nothing about what is printed`
        : 'this stock carries a pre-printed MICR band and the profile declares no MICR toner — the band is printed by the bank or by a MICR device, never by this app',
      remediation: 'print the data fields only; a readable MICR line is not something this phase produces (§9)',
    })
  }

  const { x: dpiX, y: dpiY } = profile.nominalDpi
  if (Number.isFinite(dpiX) && Number.isFinite(dpiY) && dpiX > 0 && dpiY > 0 && dpiX !== dpiY) {
    const mismatch = Math.max(dpiX, dpiY) / Math.min(dpiX, dpiY) - 1
    add({
      code: 'PROFILE_DPI_MISMATCH',
      severity: mismatch > DPI_MISMATCH_BLOCKS_ABOVE ? 'error' : 'warning',
      message: `${profile.name} reports ${String(dpiX)}x${String(dpiY)} dpi: a non-square dot grid shifts x and y by different amounts when the page is rasterised (${String(Math.round(mismatch * 100))}% apart)`,
      remediation: 'set the driver to a square resolution; mm geometry is not rescaled by DPI, so this is the driver rounding, not us',
    })
  }
}

function addMarginIssues(
  context: SafetyContext,
  add: (issue: PrintingIssue) => void
): void {
  const { profile, layout, template } = context
  const margin = profile.unprintableMarginMm
  const transform = {
    profile,
    calibration: context.calibration,
  }
  for (const run of layout.runs) {
    const rect: MmRect = transformRect(
      { xMm: run.xMm, yMm: run.yMm, widthMm: run.widthMm, heightMm: run.heightMm },
      transform
    )
    const printable = {
      xMm: margin.leftMm,
      yMm: margin.topMm,
      widthMm: template.paper.widthMm - margin.leftMm - margin.rightMm,
      heightMm: template.paper.heightMm - margin.topMm - margin.bottomMm,
    }
    const outside =
      rect.xMm < printable.xMm - 0.01 ||
      rect.yMm < printable.yMm - 0.01 ||
      rect.xMm + rect.widthMm > printable.xMm + printable.widthMm + 0.01 ||
      rect.yMm + rect.heightMm > printable.yMm + printable.heightMm + 0.01
    if (outside) {
      add({
        code: 'RUN_IN_UNPRINTABLE_MARGIN',
        severity: 'error',
        fieldId: run.fieldId,
        message: `"${run.label}" lands partly in the ${profile.name} unprintable margin (${String(margin.topMm)}/${String(margin.rightMm)}/${String(margin.bottomMm)}/${String(margin.leftMm)}mm)`,
        remediation: 'move the field, or correct the profile margins — toner does not stick in the gripper band',
      })
    }
    if (rect.xMm + rect.widthMm > template.paper.widthMm + 0.01 || rect.yMm + rect.heightMm > template.paper.heightMm + 0.01) {
      add({
        code: 'RUN_OFF_PAPER_AFTER_TRANSFORM',
        severity: 'error',
        fieldId: run.fieldId,
        message: `after the printer transform, "${run.label}" is pushed off the ${String(template.paper.widthMm)}x${String(template.paper.heightMm)}mm sheet`,
        remediation: 'reduce the profile offsets; a device offset should never be more than a few millimetres',
      })
    }
    if (rect.widthMm <= 0 || rect.heightMm <= 0) {
      add({
        code: 'RUN_COLLAPSED_AFTER_TRANSFORM',
        severity: 'error',
        fieldId: run.fieldId,
        message: `the transform collapses "${run.label}" to zero size`,
        remediation: 'check the profile and calibration scale factors',
      })
    }
  }
  // Two runs that only touch because of the transform (skew) are still a collision on paper.
  for (let i = 0; i < layout.runs.length; i += 1) {
    for (let j = i + 1; j < layout.runs.length; j += 1) {
      const first = layout.runs[i]
      const second = layout.runs[j]
      if (first === undefined || second === undefined) continue
      const a = transformRect(first, transform)
      const b = transformRect(second, transform)
      if (rectsOverlap(a, b, 0.25) && first.text.trim() !== '' && second.text.trim() !== '') {
        add({
          code: 'RUN_COLLISION_AFTER_TRANSFORM',
          severity: 'error',
          fieldId: first.fieldId,
          message: `"${first.label}" and "${second.label}" collide once this printer's offsets and scale are applied, even though the raw layout does not`,
          remediation: 'the printer is rescaling the page; disable driver scaling and re-calibrate',
        })
      }
    }
  }
}

function addAmountIssues(
  context: SafetyContext,
  policy: PrintPolicy,
  add: (issue: PrintingIssue) => void
): void {
  const amount = context.data.amountDecimal.trim()
  if (amount === '') {
    add({
      code: 'AMOUNT_MISSING',
      severity: 'error',
      message: 'no amount to print — a blank amount box is not a cheque',
      remediation: 'enter the amount',
    })
    return
  }
  const integerPart = amount.split('.')[0] ?? ''
  const digits = integerPart.replace(/^0+/, '')
  if (digits === '' && /(?:^|\.)0*$/.test(amount)) {
    add({
      code: 'AMOUNT_ZERO',
      severity: 'warning',
      message: 'the amount is zero; confirm this is a deliberate courtesy instrument and not a data error',
      remediation: 'verify the amount against the invoice',
    })
  }
  if (policy.highAmountDecimal !== null && compareDecimalStrings(amount, policy.highAmountDecimal) > 0) {
    add({
      code: 'HIGH_AMOUNT',
      severity: 'warning',
      message: `amount ${amount} exceeds the configured limit of ${policy.highAmountDecimal}`,
      remediation: 'double-check the payee and the amount with a second person if your procedure requires it',
    })
  }
}

function compareDecimalStrings(a: string, b: string): number {
  const [aInt = '0', aFrac = ''] = a.split('.')
  const [bInt = '0', bFrac = ''] = b.split('.')
  const aDigits = aInt.replace(/^0+(?=\d)/, '')
  const bDigits = bInt.replace(/^0+(?=\d)/, '')
  if (aDigits.length !== bDigits.length) return aDigits.length < bDigits.length ? -1 : 1
  if (aDigits !== bDigits) return aDigits < bDigits ? -1 : 1
  const aFraction = (aFrac + '00').slice(0, 2)
  const bFraction = (bFrac + '00').slice(0, 2)
  if (aFraction === bFraction) return 0
  return aFraction < bFraction ? -1 : 1
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso)
  const to = Date.parse(toIso)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0
  return (to - from) / 86_400_000
}

function uniqueCodes(items: readonly PrintingIssue[]): string[] {
  return [...new Set(items.map((item) => item.code))].sort()
}

function summarise(
  context: SafetyContext,
  errors: readonly PrintingIssue[],
  warnings: readonly PrintingIssue[],
  calibration: PrinterCalibration | null
): string {
  const geometry = `${String(context.template.paper.widthMm)}x${String(context.template.paper.heightMm)}mm`
  const cal =
    calibration === null
      ? 'uncalibrated'
      : `calibrated ${String(calibration.offsetXMm)}/${String(calibration.offsetYMm)}mm @ ${calibration.confidence}`
  return (
    `${context.template.name} v${String(context.template.version)} (${geometry}, ${context.layout.runCount} runs, ` +
    `hash ${context.layout.layoutHash}) on ${context.profile.name} — ${cal}. ` +
    `${String(errors.length)} blocking, ${String(warnings.length)} to acknowledge.`
  )
}

/**
 * Validate an operator's confirmation against the report it claims to confirm. The confirmation is
 * bound to a nonce: acknowledge the right codes, or the print stays locked.
 */
export function assertSafetyCleared(
  report: SafetyReport,
  confirmation: PrintConfirmation | null
): void {
  if (report.blocked) {
    throw new PrintBlockedError(
      `print blocked by ${String(report.errors.length)} error(s) on ${report.summary}`,
      report.errors,
      report.warnings
    )
  }
  if (!report.requiresConfirmation || report.acknowledgementsRequired.length === 0) return
  if (confirmation === null) {
    throw new PrintBlockedError(
      `printing requires an explicit acknowledgement of: ${report.acknowledgementsRequired.join(', ')}`,
      [],
      report.warnings
    )
  }
  if (confirmation.nonce !== report.nonce) {
    throw new PrintBlockedError(
      'the confirmation does not match this safety report — the report changed after the operator read it',
      [],
      report.warnings
    )
  }
  if (confirmation.actorId.trim() === '') {
    throw new PrintBlockedError('a confirmation must name who gave it', [], report.warnings)
  }
  const missing = report.acknowledgementsRequired.filter((code) => !confirmation.acknowledged.includes(code))
  if (missing.length > 0) {
    throw new PrintBlockedError(
      `unacknowledged safety warnings: ${missing.join(', ')}`,
      [],
      report.warnings.filter((warning) => missing.includes(warning.code))
    )
  }
}

export function createConfirmation(
  report: SafetyReport,
  actorId: string,
  acknowledged: readonly string[] = report.acknowledgementsRequired,
  at: string = new Date().toISOString()
): PrintConfirmation {
  return Object.freeze({
    nonce: report.nonce,
    acknowledged: Object.freeze([...new Set(acknowledged)].sort()),
    actorId,
    confirmedAt: at,
  })
}
