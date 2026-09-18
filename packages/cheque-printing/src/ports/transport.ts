/**
 * Print transport port — the seam between "we produced a document" and "toner moved".
 *
 * The engine never calls `window.print()` on the live page and never injects a `<style>` element
 * into the app's own document (that is the defect in §8.7 that this phase replaces). It renders a
 * complete, isolated print document and hands it to a transport. Which transport — an iframe, a PDF
 * writer, an OS driver, a network spooler — is the application's choice and can be swapped without
 * touching geometry, templates or jobs.
 */

import type { PrintJobRecord } from '../printing/PrintJob'

export interface PrintResult {
  readonly jobId: string
  /** Byte length of the submitted document — recorded so a re-send can be proven identical. */
  readonly documentBytes: number
  readonly documentHash: string
  readonly pages: number
  readonly submittedAt: string
  readonly transport: string
  /**
   * True when the transport cannot observe the outcome (a browser print dialog can be dismissed
   * silently). The service records `sent` and lets an operator complete it; pretending the paper
   * came out because a function returned would corrupt the print record.
   */
  readonly outcomeObserved: boolean
  readonly note?: string
}

export interface PrintTransport {
  readonly id: string
  /** Human-readable label for the UI ("Browser print dialog (isolated iframe)"). */
  readonly label: string
  readonly supportsOutcomeFeedback: boolean
  submit(document: RenderedPrintDocument, job: PrintJobRecord): Promise<PrintResult>
}

export interface RenderedPrintDocument {
  readonly html: string
  readonly mimeType: 'text/html'
  readonly encoding: 'utf-8'
  readonly pageWidthMm: number
  readonly pageHeightMm: number
  readonly marginMm: number
  readonly runCount: number
  readonly layoutHash: string
  readonly templateId: string
  readonly templateVersion: number
  readonly bytes: number
  readonly hash: string
}
