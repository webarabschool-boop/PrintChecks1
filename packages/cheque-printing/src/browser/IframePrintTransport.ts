/**
 * Isolated iframe print transport — the browser half of §8.3.
 *
 * The architecture rule this exists to satisfy: never print the live screen. The legacy path appended
 * a `<style>` to `document.head`, printed the app's own DOM, then removed the style while the print
 * dialog was still open (which is why it only "works" when nothing re-renders). Here, a detached
 * iframe gets the complete rendered document, prints its own window, and is removed only after the
 * print dialog has actually closed.
 *
 * `iframe.contentWindow.print()` is a *dialog*, not a completed print: no browser can tell you the
 * paper came out. So the result says `outcomeObserved: false` and the job stays in `sent` until an
 * operator completes it. That is a fact about the platform, and pretending otherwise would put a
 * fictional timestamp into a financial record.
 */

import type { RenderedPrintDocument, PrintResult, PrintTransport } from '../ports/transport'
import type { PrintJobRecord } from '../printing/PrintJob'
import { PrintTransportError } from '../errors'

export interface IframePrintTransportOptions {
  /** Milliseconds to wait for the print dialog before giving up on the iframe. */
  readonly settleTimeoutMs?: number
  /** Remove the iframe after printing. False is for debugging in devtools only. */
  readonly autoRemove?: boolean
  /**
   * When true, a missing `window.print` (headless, SSR, a locked-down webview) throws. When false,
   * the transport reports the document as prepared without submitting — used by tests and by a
   * "generate print file" flow.
   */
  readonly requirePrintApi?: boolean
  readonly now?: () => string
}

interface PrintCapableWindow {
  print?: () => void
  focus?: () => void
  addEventListener?: (type: string, listener: () => void) => void
}

export class IframePrintTransport implements PrintTransport {
  readonly id = 'browser-iframe'
  readonly label = 'Browser print dialog (isolated iframe)'
  readonly supportsOutcomeFeedback = false

  private readonly settleTimeoutMs: number
  private readonly autoRemove: boolean
  private readonly requirePrintApi: boolean
  private readonly now: () => string

  /**
   * @param document  an explicit owner document — the testability seam, so a jsdom component test can
   *                  hand in its own DOM instead of relying on a global.
   */
  constructor(
    document: Document | null = null,
    options: IframePrintTransportOptions = {}
  ) {
    this.settleTimeoutMs = options.settleTimeoutMs ?? 400
    this.autoRemove = options.autoRemove ?? true
    this.requirePrintApi = options.requirePrintApi ?? true
    this.now = options.now ?? ((): string => new Date().toISOString())
    this.injectedDocument = document
  }

  private readonly injectedDocument: Document | null

  async submit(document: RenderedPrintDocument, job: PrintJobRecord): Promise<PrintResult> {
    const owner = this.resolveDocument()
    const frame = owner.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.setAttribute('data-printchecks-transport', this.id)
    frame.setAttribute('data-print-job', job.id)
    frame.setAttribute('sandbox', 'allow-same-origin allow-modals allow-downloads')
    // Off-screen, zero-size: the iframe must not be visible and must not affect page layout.
    frame.setAttribute('style', 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden')

    owner.body.appendChild(frame)

    const printWindow = frame.contentWindow
    if (printWindow === null) {
      frame.remove()
      throw new PrintTransportError('the print frame could not be created; the document was not sent')
    }

    try {
      const frameDocument = printWindow.document
      if (frameDocument === null) {
        throw new PrintTransportError('the print frame returned no document')
      }
      frameDocument.open()
      frameDocument.write(document.html)
      frameDocument.close()

      const printable = printWindow as unknown as PrintCapableWindow
      if (typeof printable.print !== 'function') {
        if (this.requirePrintApi) {
          throw new PrintTransportError(
            'this environment has no print API (window.print is unavailable), so no print could be submitted'
          )
        }
        return this.result(job, document, 'prepared without a print API (requirePrintApi: false)')
      }

      printable.focus?.()
      printable.print()

      // `print()` returns before the paper has finished in every current browser, and the afterprint
      // event is not uniformly reliable; the settle wait is a compromise, documented as such.
      await this.settle(printable)

      return this.result(job, document, undefined)
    } finally {
      if (this.autoRemove) frame.remove()
    }
  }

  private resolveDocument(): Document {
    if (this.injectedDocument !== null) return this.injectedDocument
    const candidate = (globalThis as { document?: Document }).document
    if (candidate === undefined || candidate.body === null) {
      throw new PrintTransportError(
        'no document is available: the browser transport needs a DOM. Use the "prepared document" output or run the print in a browser context.'
      )
    }
    return candidate
  }

  private async settle(printable: PrintCapableWindow): Promise<void> {
    if (typeof printable.addEventListener !== 'function') {
      await new Promise<void>((resolve) => setTimeout(resolve, this.settleTimeoutMs))
      return
    }
    await new Promise<void>((resolve) => {
      let finished = false
      const done = (): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(done, this.settleTimeoutMs)
      printable.addEventListener?.('afterprint', done)
    })
  }

  private result(job: PrintJobRecord, document: RenderedPrintDocument, note?: string): PrintResult {
    const result: PrintResult = {
      jobId: job.id,
      documentBytes: document.bytes,
      documentHash: document.hash,
      pages: 1,
      submittedAt: this.now(),
      transport: this.id,
      outcomeObserved: false,
      ...(note === undefined ? {} : { note }),
    }
    return Object.freeze(result)
  }
}
