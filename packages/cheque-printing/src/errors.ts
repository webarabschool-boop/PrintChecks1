/**
 * Error types for the printing package.
 *
 * Rule P11 / S4 of the architecture: no silent failure. Anything that can stop a physical
 * cheque from being printed correctly is an exception with a machine-readable `code`, and every
 * exception carries the structured detail a UI needs to explain itself — never a bare string.
 */

export interface PrintingIssue {
  readonly code: string
  readonly severity: 'error' | 'warning'
  readonly message: string
  /** What the operator can do about it. Surfaced directly in the designer UI. */
  readonly remediation?: string
  readonly fieldId?: string
  readonly templateId?: string
}

export class ChequePrintingError extends Error {
  readonly code: string
  readonly issues: readonly PrintingIssue[]

  constructor(message: string, code: string, issues: readonly PrintingIssue[] = []) {
    super(message)
    this.name = 'ChequePrintingError'
    this.code = code
    this.issues = issues
  }
}

export class TemplateValidationError extends ChequePrintingError {
  constructor(
    readonly templateName: string,
    readonly errors: readonly PrintingIssue[]
  ) {
    const detail = errors.map((issue) => `${issue.code}: ${issue.message}`).join('; ')
    super(
      `template "${templateName}" is not printable — ${errors.length} error(s): ${detail}`,
      'TEMPLATE_VALIDATION_FAILED',
      errors
    )
    this.name = 'TemplateValidationError'
  }
}

export class PrintBlockedError extends ChequePrintingError {
  constructor(
    message: string,
    readonly blockers: readonly PrintingIssue[],
    readonly warnings: readonly PrintingIssue[] = []
  ) {
    super(message, 'PRINT_BLOCKED', [...blockers, ...warnings])
    this.name = 'PrintBlockedError'
  }
}

export class PrintJobTransitionError extends ChequePrintingError {
  constructor(
    readonly jobId: string,
    readonly from: string,
    readonly to: string
  ) {
    super(
      `illegal print-job transition "${from}" → "${to}" (job ${jobId}). ` +
        `Legal path: created → queued → authorised → rendering → sent → completed; ` +
        `failure/retry and pre-send cancellation only.`,
      'INVALID_PRINT_JOB_TRANSITION'
    )
    this.name = 'PrintJobTransitionError'
  }
}

export class PrintTransportError extends ChequePrintingError {
  constructor(message: string, cause?: unknown) {
    super(message, 'PRINT_TRANSPORT_FAILED')
    this.name = 'PrintTransportError'
    if (cause !== undefined) {
      ;(this as Error & { cause?: unknown }).cause = cause
    }
  }
}

export class AmountInWordsError extends ChequePrintingError {
  constructor(message: string, cause?: unknown) {
    super(message, 'AMOUNT_IN_WORDS_UNAVAILABLE')
    this.name = 'AmountInWordsError'
    if (cause !== undefined) {
      ;(this as Error & { cause?: unknown }).cause = cause
    }
  }
}

export class CalibrationRequiredError extends ChequePrintingError {
  constructor(
    readonly printerProfileId: string,
    readonly templateId: string
  ) {
    super(
      `no calibration is recorded for printer "${printerProfileId}" with stock "${templateId}". ` +
        `Printing without calibration is allowed only when an operator explicitly accepts the ` +
        `risk — the system never silently assumes a zero offset (§8.5).`,
      'CALIBRATION_MISSING'
    )
    this.name = 'CalibrationRequiredError'
  }
}
