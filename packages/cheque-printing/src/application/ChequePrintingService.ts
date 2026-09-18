/**
 * ChequePrintingService — the application layer of Phase 2.
 *
 * Everything above this class (a Vue view, an Express route, a CLI) talks to one object; everything
 * below it is injected. The four guarantees that a UI cannot provide and a use case must:
 *
 *  1. a template is used only after validation and only as an immutable published version;
 *  2. a print is staged → safety-assessed → explicitly authorised → sent, never "print on click";
 *  3. the job record pins template id + version + hash and the layout hash, so a reprint reprints
 *     what was printed rather than whatever the template says today (rule A4);
 *  4. every step is written to the append-only audit chain inside the same operation, so no action
 *     succeeds without its record (rule A3).
 *
 * No DOM, no framework, no storage or clock ownership: `store`, `transport`, `amountInWords` and
 * `now` are injected, which is what makes every line here testable in bare Node.
 */

import {
  calibrationFingerprint,
  createPrinterCalibration,
  deriveCalibration,
  validatePrinterCalibration,
  type CreateCalibrationInput,
  type DeriveCalibrationInput,
} from '../printer/calibration'
import { createPrinterProfile, validatePrinterProfile } from '../printer/profile'
import type { PrinterCalibration, PrinterProfile } from '../printer/types'
import { buildRegistrationTestPage, renderTestPageDocument, type TestPageSpec } from '../printer/testPage'
import {
  assertTemplateValid,
  createBankChequeTemplate,
  nextTemplateVersion,
  validateTemplate,
  type TemplateValidationReport,
} from '../template'
import { BUILTIN_TEMPLATES } from '../template/builtins'
import { TemplateRegistry, type PublishReport } from '../template/TemplateRegistry'
import type { BankChequeTemplate, CreateTemplateInput } from '../template'
import { buildPrintLayout, type BuildLayoutOptions } from '../layout/engine'
import type { PrintLayout } from '../layout/types'
import { createChequePrintData, type CreatePrintDataOptions } from '../printdata/create'
import type { ChequePrintData } from '../printdata/types'
import {
  createPrintJob,
  documentFingerprint,
  isCancellable,
  transitionJob,
  verifyJobRecord,
  type ChequePrintJob,
} from '../printing/PrintJob'
import {
  assertSafetyCleared,
  assessPrintSafety,
  DEFAULT_PRINT_POLICY,
  type PrintConfirmation,
  type PrintPolicy,
  type SafetyReport,
} from '../printing/safety'
import { renderPrintDocument } from '../printing/render'
import {
  appendAuditRecord,
  describeAuditRecord,
  type PrintAuditAction,
  type PrintAuditContext,
  type PrintAuditRecord,
} from '../printing/audit'
import {
  AuditRecordRepository,
  CalibrationRecordRepository,
  InMemoryPrintingRecordStore,
  JobRecordRepository,
  ProfileRecordRepository,
  TemplateRecordRepository,
} from '../infrastructure'
import type { PrintingRecordStore } from '../ports/recordStore'
import type { RenderedPrintDocument, PrintResult, PrintTransport } from '../ports/transport'
import {
  UnavailableAmountInWordsConverter,
  type AmountInWordsConverter,
} from '../ports/amountInWords'
import { ChequePrintingError, PrintBlockedError } from '../errors'

export interface ChequePrintingServiceOptions {
  readonly store?: PrintingRecordStore
  readonly registry?: TemplateRegistry
  readonly transport?: PrintTransport | null
  readonly amountInWords?: AmountInWordsConverter
  readonly policy?: Partial<PrintPolicy>
  /** Injectable clock — use cases never read the time themselves (mirrors cheque-core). */
  readonly now?: () => string
  readonly idFactory?: (kind: 'job' | 'calibration' | 'profile' | 'audit' | 'template') => string
  readonly actorId?: string | null
  readonly actorName?: string | null
  /** Publish the built-in bank stock definitions on construction. Default true. */
  readonly seedBuiltins?: boolean
}

export interface StagedPrintJob {
  readonly job: ChequePrintJob
  readonly safety: SafetyReport
  readonly document: RenderedPrintDocument
  readonly layout: PrintLayout
  /** Kept so authorisation can re-assess against the same values the operator previewed. */
  readonly data: ChequePrintData
}

export interface StagePrintInput {
  readonly templateId: string
  /** Pin a specific published version; omit for the latest. */
  readonly templateVersion?: number
  readonly data: ChequePrintData
  readonly printerProfileId: string
  readonly isReprint?: boolean
  readonly layoutOptions?: BuildLayoutOptions
  readonly actorId?: string | null
}

export interface AuthoriseInput {
  readonly jobId: string
  readonly actorId: string
  readonly reason?: string | null
  readonly confirmation?: PrintConfirmation | null
  readonly acknowledged?: readonly string[]
  readonly sendNow?: boolean
}

export interface PreviewInput {
  readonly templateId: string
  readonly templateVersion?: number
  readonly data: ChequePrintData
  readonly printerProfileId?: string
  readonly options?: BuildLayoutOptions
}

export interface PreviewResult {
  readonly layout: PrintLayout
  readonly template: BankChequeTemplate
  readonly profile: PrinterProfile | null
  readonly calibration: PrinterCalibration | null
  readonly safety: SafetyReport | null
}

let localCounter = 0

/**
 * Default id factory for hosts that do not inject one. A real deployment should inject the core's
 * `CryptoIdGenerator`; this exists so the package stays usable standalone (and so ids are never
 * derived from a cheque number or an amount).
 */
function defaultId(kind: 'job' | 'calibration' | 'profile' | 'audit' | 'template'): string {
  localCounter += 1
  return `${kind}_${localCounter.toString(36).padStart(4, '0')}`
}

export class ChequePrintingService {
  readonly registry: TemplateRegistry
  private readonly store: PrintingRecordStore
  private readonly templates: TemplateRecordRepository
  private readonly profiles: ProfileRecordRepository
  private readonly calibrations: CalibrationRecordRepository
  private readonly jobs: JobRecordRepository
  private readonly audit: AuditRecordRepository

  private readonly transport: PrintTransport | null
  private readonly amountInWords: AmountInWordsConverter
  private readonly policy: PrintPolicy
  private readonly now: () => string
  private readonly idFactory: NonNullable<ChequePrintingServiceOptions['idFactory']>
  private readonly actorId: string | null

  /** Staged jobs are held in memory until authorised; nothing half-printed is persisted. */
  private readonly staged = new Map<string, StagedPrintJob>()
  private readonly jobCache = new Map<string, ChequePrintJob>()

  constructor(options: ChequePrintingServiceOptions = {}) {
    this.store = options.store ?? new InMemoryPrintingRecordStore()
    this.templates = new TemplateRecordRepository(this.store)
    this.profiles = new ProfileRecordRepository(this.store)
    this.calibrations = new CalibrationRecordRepository(this.store)
    this.jobs = new JobRecordRepository(this.store)
    this.audit = new AuditRecordRepository(this.store)
    this.transport = options.transport ?? null
    this.amountInWords = options.amountInWords ?? new UnavailableAmountInWordsConverter()
    this.policy = { ...DEFAULT_PRINT_POLICY, ...(options.policy ?? {}) }
    this.now = options.now ?? ((): string => new Date().toISOString())
    this.idFactory = options.idFactory ?? defaultId
    this.actorId = options.actorId ?? null
    this.registry =
      options.registry ??
      new TemplateRegistry({
        // A published version that some job already pinned must not be deletable.
        isVersionReferenced: (templateId, version) =>
          [...this.jobCache.values()].some(
            (job) => job.pin.templateId === templateId && job.pin.templateVersion === version
          ),
      })

    if (options.seedBuiltins !== false) {
      for (const template of BUILTIN_TEMPLATES) {
        this.registry.publish(template)
      }
    }
  }

  /**
   * Load persisted records into the registry. Explicit rather than run in the constructor: every
   * read is async, and a service that silently half-loaded its state would let an operator print
   * against a template the designer never showed them.
   */
  async load(): Promise<{ templates: number; profiles: number; calibrations: number; jobs: number }> {
    const templateRecords = await this.templates.findAll()
    for (const record of templateRecords) {
      if (validateTemplate(record.template, { allowEmpty: true }).ok) {
        this.registry.publish(record.template)
      }
    }
    return {
      templates: templateRecords.length,
      profiles: (await this.profiles.findAll()).length,
      calibrations: (await this.calibrations.findAll()).length,
      jobs: (await this.jobs.findAll()).length,
    }
  }

  // -------------------------------------------------------------------------
  // Templates
  // -------------------------------------------------------------------------

  createTemplate(input: CreateTemplateInput): BankChequeTemplate {
    return createBankChequeTemplate(input)
  }

  /** Validate without side effects — the designer calls this on every keystroke. */
  inspectTemplate(template: BankChequeTemplate): TemplateValidationReport {
    return validateTemplate(template, { allowEmpty: true })
  }

  async publishTemplate(template: BankChequeTemplate): Promise<PublishReport> {
    assertTemplateValid(template)
    const report = this.registry.publish(template)
    await this.templates.saveTemplate(report.template)
    await this.appendAudit(report.createdVersion === 1 ? 'template.published' : 'template.versioned', {
      entityType: 'BankChequeTemplate',
      entityId: report.template.id,
      context: {
        templateId: report.template.id,
        templateVersion: report.template.version,
        templateHash: report.template.templateHash,
      },
      values: { name: report.template.name, fields: report.template.fields.length },
      reason: `version ${String(report.createdVersion)} of ${report.template.name}`,
    })
    return report
  }

  /** Change a published template by deriving a new version (rule T4: never edit in place). */
  async reviseTemplate(
    templateId: string,
    changes: Parameters<typeof nextTemplateVersion>[1],
    options: { readonly publish?: boolean } = {}
  ): Promise<BankChequeTemplate> {
    const current = this.registry.get(templateId)
    if (current === null) {
      throw new ChequePrintingError(
        `cannot revise "${templateId}": no published template with that id`,
        'TEMPLATE_NOT_FOUND'
      )
    }
    const candidate = nextTemplateVersion(current, changes, { createdAt: this.now() })
    if (options.publish === false) return candidate
    await this.publishTemplate(candidate)
    return candidate
  }

  async setTemplateActive(
    templateId: string,
    version: number,
    isActive: boolean
  ): Promise<BankChequeTemplate> {
    const updated = this.registry.setActive(templateId, version, isActive, this.now())
    await this.templates.saveTemplate(updated)
    await this.appendAudit(isActive ? 'template.activated' : 'template.deactivated', {
      entityType: 'BankChequeTemplate',
      entityId: `${templateId}:v${String(version)}`,
      context: { templateId, templateVersion: version, templateHash: updated.templateHash },
    })
    return updated
  }

  listTemplates(bankId?: string): BankChequeTemplate[] {
    return this.registry.findActive(bankId)
  }

  getTemplate(templateId: string, version?: number): BankChequeTemplate | null {
    return this.registry.get(templateId, version)
  }

  // -------------------------------------------------------------------------
  // Printer profiles, calibration and the test page
  // -------------------------------------------------------------------------

  async saveProfile(input: Parameters<typeof createPrinterProfile>[0]): Promise<PrinterProfile> {
    const at = this.now()
    const profile = createPrinterProfile({ ...input, id: input.id === '' ? this.idFactory('profile') : input.id }, at)
    const errors = validatePrinterProfile(profile).filter((issue) => issue.severity === 'error')
    if (errors.length > 0) {
      throw new ChequePrintingError(
        `printer profile "${profile.name}" is not usable: ${errors.map((issue) => issue.message).join('; ')}`,
        'PRINTER_PROFILE_INVALID',
        errors
      )
    }
    await this.profiles.saveProfile(profile)
    await this.appendAudit('profile.created', {
      entityType: 'PrinterProfile',
      entityId: profile.id,
      values: { name: profile.name, feed: profile.paperFeed, dpi: profile.nominalDpi.x },
    })
    return profile
  }

  listProfiles(): Promise<PrinterProfile[]> {
    return this.profiles.findAll().then((records) => records.map((record) => record.profile))
  }

  async getProfile(profileId: string): Promise<PrinterProfile | null> {
    const record = await this.profiles.findById(profileId)
    return record?.profile ?? null
  }

  /**
   * Generate the registration test page for a (printer, stock) pair. This only *produces* a
   * document: sending it to a printer is the same explicit flow as a cheque print.
   */
  async generateTestPage(input: {
    readonly profileId: string
    readonly templateId: string
    readonly templateVersion?: number
    readonly useCurrentCalibration?: boolean
    readonly measuredAt?: string
  }): Promise<{ spec: TestPageSpec; html: string; bytes: number; hash: string }> {
    const template = this.resolveTemplate(input.templateId, input.templateVersion)
    const profile = await this.getProfile(input.profileId)
    if (profile === null) {
      throw new ChequePrintingError(`unknown printer profile "${input.profileId}"`, 'PROFILE_NOT_FOUND')
    }
    const calibration =
      input.useCurrentCalibration === true
        ? await this.findCalibration(input.profileId, template.id)
        : null

    const spec = buildRegistrationTestPage({
      paper: { widthMm: template.paper.widthMm, heightMm: template.paper.heightMm },
      profileId: profile.id,
      templateId: template.id,
      templateVersion: template.version,
      // Anchors are body-relative in the template, absolute on the sheet on the page — the
      // operator measures from a paper edge, not from an abstract origin.
      fieldAnchors: template.fields
        .filter((field) => field.isPrinted)
        .map((field) => ({
          fieldId: field.id,
          label: field.label,
          xMm: field.xMm + template.paper.bodyOriginMm.xMm,
          yMm: field.yMm + template.paper.bodyOriginMm.yMm,
          widthMm: field.widthMm,
          heightMm: field.heightMm,
        })),
      ...(calibration === null ? {} : { transform: { profile, calibration } }),
      ...(input.measuredAt === undefined ? {} : { measuredAt: input.measuredAt }),
    })
    const rendered = renderTestPageDocument(spec)
    await this.appendAudit('testprint.generated', {
      entityType: 'TestPage',
      entityId: spec.id,
      context: {
        printerProfileId: profile.id,
        templateId: template.id,
        templateVersion: template.version,
        layoutHash: spec.hash,
      },
      values: { marks: spec.marks.length, calibrated: spec.calibrated },
    })
    return { spec, html: rendered.html, bytes: rendered.bytes, hash: rendered.hash }
  }

  async recordCalibration(
    input: CreateCalibrationInput & { readonly rejectIfInvalid?: boolean }
  ): Promise<PrinterCalibration> {
    const calibration = createPrinterCalibration(input, this.now())
    const errors = validatePrinterCalibration(calibration).filter((issue) => issue.severity === 'error')
    if (errors.length > 0 && input.rejectIfInvalid !== false) {
      throw new ChequePrintingError(
        `refusing to store an implausible calibration: ${errors.map((issue) => issue.message).join('; ')}`,
        'CALIBRATION_REJECTED',
        errors
      )
    }
    await this.calibrations.saveCalibration(calibration)
    await this.appendAudit('calibration.recorded', {
      entityType: 'PrinterCalibration',
      entityId: calibration.id,
      reason: `${calibration.method} (${calibration.confidence})`,
      context: {
        printerProfileId: calibration.printerProfileId,
        templateId: calibration.templateId,
        templateVersion: calibration.templateVersion,
      },
      values: {
        offsetXMm: calibration.offsetXMm,
        offsetYMm: calibration.offsetYMm,
        scaleX: calibration.scaleX,
        scaleY: calibration.scaleY,
      },
    })
    return calibration
  }

  /** Turn measured points from a printed test page into a stored calibration. */
  async calibrateFromMeasurements(
    input: DeriveCalibrationInput & { readonly rejectIfImplausible?: boolean }
  ): Promise<PrinterCalibration> {
    const derived = deriveCalibration(input)
    if (input.rejectIfImplausible === true && derived.calibration.confidence === 'draft') {
      throw new ChequePrintingError(
        `a calibration from ${String(input.points.length)} point(s) is a draft: measure at least three marks`,
        'CALIBRATION_INSUFFICIENT_POINTS'
      )
    }
    return await this.recordCalibration({
      id: derived.calibration.id,
      printerProfileId: input.printerProfileId,
      templateId: input.templateId,
      templateVersion: input.templateVersion,
      offsetXMm: derived.calibration.offsetXMm,
      offsetYMm: derived.calibration.offsetYMm,
      scaleX: derived.calibration.scaleX,
      scaleY: derived.calibration.scaleY,
      skewDeg: derived.calibration.skewDeg,
      method: derived.calibration.method,
      confidence: derived.calibration.confidence,
      measuredBy: input.measuredBy ?? null,
      sourceTestPageHash: input.testPageHash ?? null,
      notes: derived.notes,
    })
  }

  async verifyCalibration(calibrationId: string): Promise<PrinterCalibration> {
    const all = await this.calibrations.findAll()
    const found = all.find((entry) => entry.calibration.id === calibrationId)
    if (found === undefined) {
      throw new ChequePrintingError(`unknown calibration "${calibrationId}"`, 'CALIBRATION_NOT_FOUND')
    }
    const verified: PrinterCalibration = Object.freeze({ ...found.calibration, confidence: 'verified' as const })
    await this.calibrations.saveCalibration(verified)
    await this.appendAudit('calibration.verified', {
      entityType: 'PrinterCalibration',
      entityId: verified.id,
      reason: 'verification test page matched the expected coordinates',
      context: {
        printerProfileId: verified.printerProfileId,
        templateId: verified.templateId,
        templateVersion: verified.templateVersion,
      },
    })
    return verified
  }

  findCalibration(printerProfileId: string, templateId: string): Promise<PrinterCalibration | null> {
    return this.calibrations.findForPair(printerProfileId, templateId)
  }

  listCalibrations(): Promise<PrinterCalibration[]> {
    return this.calibrations.findAll().then((records) => records.map((record) => record.calibration))
  }

  // -------------------------------------------------------------------------
  // Layout and preview
  // -------------------------------------------------------------------------

  buildLayout(
    template: BankChequeTemplate,
    data: ChequePrintData,
    options: BuildLayoutOptions = {}
  ): PrintLayout {
    return buildPrintLayout({
      template,
      data,
      options: { amountInWords: this.amountInWords, ...options },
    })
  }

  async preview(input: PreviewInput): Promise<PreviewResult> {
    const template = this.resolveTemplate(input.templateId, input.templateVersion)
    const layout = this.buildLayout(template, input.data, input.options ?? {})
    const profile = input.printerProfileId === undefined ? null : await this.getProfile(input.printerProfileId)
    const calibration = profile === null ? null : await this.findCalibration(profile.id, template.id)
    const safety =
      profile === null
        ? null
        : assessPrintSafety({
            template,
            layout,
            data: input.data,
            profile,
            calibration,
            policy: this.policy,
            now: this.now(),
          })
    return { layout, template, profile, calibration, safety }
  }

  normalizePrintData(
    input: Parameters<typeof createChequePrintData>[0],
    options?: CreatePrintDataOptions
  ): ChequePrintData {
    return createChequePrintData(input, options)
  }

  // -------------------------------------------------------------------------
  // The print flow: stage → authorise → send → complete
  // -------------------------------------------------------------------------

  /**
   * Build the layout and the document, run the safety assessment, and hold the result. Nothing is
   * persisted and nothing is printed here: the caller must go on to {@link authorise}.
   */
  async stage(input: StagePrintInput): Promise<StagedPrintJob> {
    const template = this.resolveTemplate(input.templateId, input.templateVersion)
    const profile = await this.getProfile(input.printerProfileId)
    if (profile === null) {
      throw new ChequePrintingError(
        `no printer profile "${input.printerProfileId}": the engine must know which device it is printing on`,
        'PROFILE_NOT_FOUND'
      )
    }
    const calibration = await this.findCalibration(profile.id, template.id)
    const layout = this.buildLayout(template, input.data, input.layoutOptions ?? {})
    const document = renderPrintDocument({
      layout,
      profile,
      calibration,
      options: { templateName: template.name },
    })

    const job = createPrintJob({
      id: this.idFactory('job'),
      chequeId: input.data.chequeId,
      chequeNumber: input.data.chequeNumber,
      layout,
      printerProfileId: profile.id,
      calibrationId: calibration?.id ?? null,
      calibrationFingerprint: calibration === null ? null : calibrationFingerprint(calibration),
      createdBy: input.actorId ?? this.actorId,
      createdAt: this.now(),
    })

    const safety = assessPrintSafety({
      template,
      layout,
      data: input.data,
      profile,
      calibration,
      policy: this.policy,
      now: this.now(),
      isReprint: input.isReprint ?? false,
      priorAttempts: (await this.jobs.findByChequeNumber(input.data.chequeNumber)).length,
    })

    if (safety.blocked) {
      await this.appendAudit('safety.blocked', {
        entityType: 'Safety',
        entityId: job.id,
        reason: safety.errors.map((error) => error.code).join(', '),
        context: auditContext(job, profile, calibration, document),
      })
      throw new PrintBlockedError(
        `print blocked before it could be staged: ${safety.errors.map((error) => error.message).join('; ')}`,
        safety.errors,
        safety.warnings
      )
    }

    const fingerprint = documentFingerprint(document.html, document.runCount)
    const queued = transitionJob(
      Object.freeze({ ...job, document: { ...job.document, ...fingerprint } }),
      'queued',
      { at: this.now(), actorId: input.actorId ?? this.actorId }
    )

    const entry: StagedPrintJob = { job: queued, safety, document, layout, data: input.data }
    this.staged.set(queued.id, entry)
    this.jobCache.set(queued.id, queued)

    await this.appendAudit('job.created', {
      entityType: 'ChequePrintJob',
      entityId: queued.id,
      context: auditContext(queued, profile, calibration, document),
      values: { chequeNumber: queued.chequeNumber, runs: queued.document.runCount },
    })
    return entry
  }

  /**
   * Record the human decision and, unless `sendNow: false`, hand the document to the transport.
   * A reprint with no reason is refused here rather than in the UI, because the UI is optional.
   */
  async authorise(
    input: AuthoriseInput
  ): Promise<{ job: ChequePrintJob; result: PrintResult | null }> {
    const staged = this.staged.get(input.jobId)
    if (staged === undefined) {
      throw new ChequePrintingError(
        `job "${input.jobId}" is not staged (it may already be sent or cancelled, or the service restarted)`,
        'JOB_NOT_STAGED'
      )
    }
    const profile = await this.getProfile(staged.job.pin.printerProfileId)
    if (profile === null) {
      throw new ChequePrintingError(
        `the printer profile "${staged.job.pin.printerProfileId}" this job was staged against no longer exists`,
        'PROFILE_NOT_FOUND'
      )
    }
    // The layout is re-checked against the version the job pins — not the newest one published since.
    const template = this.resolveTemplate(staged.job.pin.templateId, staged.job.pin.templateVersion)
    if (template.templateHash !== staged.job.pin.templateHash) {
      throw new PrintBlockedError(
        `template ${staged.job.pin.templateId} v${String(staged.job.pin.templateVersion)} no longer matches the pinned hash`,
        [
          {
            code: 'TEMPLATE_HASH_MISMATCH',
            severity: 'error',
            message: `pinned ${staged.job.pin.templateHash}, stored template now hashes to ${template.templateHash}`,
            remediation: 'the published version was altered after staging — refuse and investigate',
          },
        ]
      )
    }
    const calibration = await this.findCalibration(profile.id, template.id)

    const confirmation =
      input.confirmation ??
      (input.acknowledged === undefined
        ? null
        : {
            nonce: staged.safety.nonce,
            acknowledged: [...input.acknowledged],
            actorId: input.actorId,
            confirmedAt: this.now(),
          })

    const freshSafety = assessPrintSafety({
      template,
      layout: staged.layout,
      data: staged.data,
      profile,
      calibration,
      policy: this.policy,
      now: this.now(),
      isReprint: staged.job.isReprint,
      priorAttempts: (await this.jobs.findByChequeNumber(staged.job.chequeNumber)).length,
    })

    // A report that now blocks is refused on its own merits, before any confirmation is considered:
    // telling the operator to re-read the warnings would bury the actual reason the print is stopped.
    if (freshSafety.blocked) assertSafetyCleared(freshSafety, null)
    assertSafetyCleared(freshSafety, rebindConfirmation(confirmation, staged.safety, freshSafety))

    const authorised = transitionJob(staged.job, 'authorised', {
      at: this.now(),
      actorId: input.actorId,
      reason: input.reason ?? null,
    })
    const rendering = transitionJob(authorised, 'rendering', { at: this.now(), actorId: input.actorId })
    this.staged.set(rendering.id, { ...staged, job: rendering })
    this.jobCache.set(rendering.id, rendering)

    await this.appendAudit('safety.acknowledged', {
      entityType: 'Safety',
      entityId: rendering.id,
      reason:
        confirmation === null
          ? 'no acknowledgements required'
          : `acknowledged: ${confirmation.acknowledged.join(', ') || 'none'}`,
      context: auditContext(rendering, profile, calibration, staged.document),
    })
    await this.appendAudit('job.authorised', {
      entityType: 'ChequePrintJob',
      entityId: rendering.id,
      reason: input.reason ?? null,
      context: auditContext(rendering, profile, calibration, staged.document),
    })
    await this.appendAudit('job.rendered', {
      entityType: 'ChequePrintJob',
      entityId: rendering.id,
      context: auditContext(rendering, profile, calibration, staged.document),
    })

    if (input.sendNow === false) return { job: rendering, result: null }
    return await this.send(rendering.id)
  }

  /** Give the staged document to the transport. Split out so a queue can send later. */
  async send(jobId: string): Promise<{ job: ChequePrintJob; result: PrintResult | null }> {
    const staged = this.staged.get(jobId)
    if (staged === undefined) {
      throw new ChequePrintingError(`job "${jobId}" is not staged`, 'JOB_NOT_STAGED')
    }
    if (this.transport === null) {
      throw new ChequePrintingError(
        'no print transport is configured: the document is complete but nothing could be sent to it',
        'NO_PRINT_TRANSPORT',
        [
          {
            code: 'NO_PRINT_TRANSPORT',
            severity: 'error',
            message: 'inject a PrintTransport (e.g. IframePrintTransport), or use the rendered document directly',
            remediation: 'the document is available as the staged result: .document.html',
          },
        ]
      )
    }

    const profile = await this.getProfile(staged.job.pin.printerProfileId)
    const calibration =
      profile === null ? null : await this.findCalibration(profile.id, staged.job.pin.templateId)

    let job = staged.job
    try {
      job = transitionJob(staged.job, 'sent', {
        at: this.now(),
        actorId: this.actorId,
        transportId: this.transport.id,
      })
      const result = await this.transport.submit(staged.document, job)
      // A browser cannot confirm the paper arrived, so the job stays `sent`. `completed` is an
      // operator decision (or a transport with real feedback), and the difference is the point.
      this.staged.set(jobId, { ...staged, job })
      this.jobCache.set(job.id, job)
      await this.jobs.saveJob(job)
      await this.appendAudit('job.sent', {
        entityType: 'ChequePrintJob',
        entityId: job.id,
        context: {
          ...auditContext(job, profile ?? stagedProfilePlaceholder, calibration, staged.document),
          transportId: result.transport,
        },
        values: { bytes: result.documentBytes, pages: result.pages, outcomeObserved: result.outcomeObserved },
      })
      return { job, result }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failed = transitionJob(job, 'failed', {
        at: this.now(),
        actorId: this.actorId,
        failure: { code: 'TRANSPORT_FAILED', message },
      })
      this.staged.delete(jobId)
      this.jobCache.set(failed.id, failed)
      await this.jobs.saveJob(failed)
      await this.appendAudit('job.failed', {
        entityType: 'ChequePrintJob',
        entityId: failed.id,
        reason: message,
        context: { jobId: failed.id, layoutHash: failed.pin.layoutHash },
      })
      throw error
    }
  }

  async complete(jobId: string, actorId: string): Promise<ChequePrintJob> {
    const job = await this.getJob(jobId)
    const completed = transitionJob(job, 'completed', { at: this.now(), actorId })
    this.staged.delete(jobId)
    this.jobCache.set(completed.id, completed)
    await this.jobs.saveJob(completed)
    await this.appendAudit('job.completed', {
      entityType: 'ChequePrintJob',
      entityId: completed.id,
      context: {
        jobId: completed.id,
        layoutHash: completed.pin.layoutHash,
        templateId: completed.pin.templateId,
      },
    })
    return completed
  }

  async cancel(jobId: string, actorId: string, reason: string): Promise<ChequePrintJob> {
    const job = this.staged.get(jobId)?.job ?? (await this.getJob(jobId))
    if (!isCancellable(job)) {
      throw new ChequePrintingError(
        `job "${jobId}" is ${job.status}; a job that has been sent cannot be cancelled — void the cheque instead`,
        'JOB_NOT_CANCELLABLE'
      )
    }
    const cancelled = transitionJob(job, 'cancelled', { at: this.now(), actorId, note: reason })
    this.staged.delete(jobId)
    this.jobCache.set(cancelled.id, cancelled)
    await this.jobs.saveJob(cancelled)
    await this.appendAudit('job.cancelled', {
      entityType: 'ChequePrintJob',
      entityId: cancelled.id,
      reason,
      context: { jobId: cancelled.id, layoutHash: cancelled.pin.layoutHash },
    })
    return cancelled
  }

  /**
   * A reprint is a NEW job built from the ORIGINAL job's stored layout, with the attempt counter
   * advanced and a reason required. Never "print the template again": the layout that failed is the
   * layout to retry.
   */
  async reprint(
    originalJobId: string,
    actorId: string,
    reason: string
  ): Promise<{ job: ChequePrintJob; safety: SafetyReport }> {
    if (reason.trim() === '') {
      throw new ChequePrintingError(
        'a reprint requires a recorded reason (ruined stock still consumes a number, §5.4)',
        'REPRINT_REASON_REQUIRED'
      )
    }
    const original = await this.getJob(originalJobId)
    const template = this.resolveTemplate(original.pin.templateId, original.pin.templateVersion)
    const profile = await this.requireProfile(original)
    const calibration = await this.findCalibration(profile.id, template.id)
    const jobId = this.idFactory('job')
    const job = createPrintJob({
      id: jobId,
      chequeId: original.chequeId,
      chequeNumber: original.chequeNumber,
      layout: original.layout,
      printerProfileId: profile.id,
      calibrationId: calibration?.id ?? null,
      calibrationFingerprint: calibration === null ? null : calibrationFingerprint(calibration),
      createdBy: actorId,
      createdAt: this.now(),
      reprintOf: original,
      notes: `reprint of ${original.id}: ${reason}`,
    })
    // Deliberately the same render input as `stage`, with no job id in the document metadata: a
    // reprint must produce byte-identical HTML for the pinned layout, so an auditor comparing
    // `job.document.hash` across the two records can see that the same sheet was sent twice.
    const document = renderPrintDocument({
      layout: original.layout,
      profile,
      calibration,
      options: { templateName: template.name },
    })
    const safety = assessPrintSafety({
      template,
      layout: original.layout,
      data: stagedDataFrom(original),
      profile,
      calibration,
      policy: this.policy,
      now: this.now(),
      isReprint: true,
      priorAttempts: (await this.jobs.findByChequeNumber(original.chequeNumber)).length,
    })
    const fingerprint = documentFingerprint(document.html, document.runCount)
    // Queued, exactly like a first attempt: the reprint is a new job that still has to be authorised.
    const entry: StagedPrintJob = {
      job: transitionJob(
        Object.freeze({ ...job, document: { ...job.document, ...fingerprint } }),
        'queued',
        { at: this.now(), actorId }
      ),
      safety,
      document,
      layout: original.layout,
      data: stagedDataFrom(original),
    }
    this.staged.set(jobId, entry)
    this.jobCache.set(jobId, entry.job)
    await this.appendAudit('job.retried', {
      entityType: 'ChequePrintJob',
      entityId: jobId,
      reason,
      context: { ...auditContext(entry.job, profile, calibration, document), reprintOfJobId: original.id },
      values: { attempt: entry.job.attempt, isReprint: true },
    })
    return { job: entry.job, safety }
  }

  async getJob(jobId: string): Promise<ChequePrintJob> {
    const cached = this.jobCache.get(jobId)
    if (cached !== undefined) return cached
    const record = await this.jobs.findById(jobId)
    if (record === null) {
      throw new ChequePrintingError(`unknown print job "${jobId}"`, 'JOB_NOT_FOUND')
    }
    return record.job
  }

  async recentJobs(limit = 20): Promise<ChequePrintJob[]> {
    const stored = await this.jobs.findRecent()
    const stagedOnly = [...this.staged.values()]
      .map((entry) => entry.job)
      .filter((job) => !stored.some((existing) => existing.id === job.id))
    return [...stagedOnly, ...stored].slice(0, limit)
  }

  async jobsForChequeNumber(chequeNumber: string): Promise<ChequePrintJob[]> {
    const stored = await this.jobs.findByChequeNumber(chequeNumber)
    const staged = [...this.staged.values()]
      .map((entry) => entry.job)
      .filter((job) => job.chequeNumber === chequeNumber)
    return [...staged, ...stored]
  }

  /** Rule A4 in action: does the stored record still match what it pins? */
  async verifyJob(jobId: string): Promise<{ ok: boolean; problems: readonly string[] }> {
    const job = await this.getJob(jobId)
    const problems: string[] = [...verifyJobRecord(job).problems]
    const template = this.registry.get(job.pin.templateId, job.pin.templateVersion)
    if (template === null) {
      problems.push(`pinned version ${job.pin.templateId}:v${String(job.pin.templateVersion)} is no longer published`)
    } else if (template.templateHash !== job.pin.templateHash) {
      problems.push(
        `pinned template hash ${job.pin.templateHash} does not match the stored copy (${template.templateHash})`
      )
    }
    return { ok: problems.length === 0, problems }
  }

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  async auditLog(limit?: number): Promise<PrintAuditRecord[]> {
    const records = await this.audit.readAll()
    return limit === undefined ? records : records.slice(Math.max(0, records.length - limit))
  }

  async auditSummary(limit = 10): Promise<string[]> {
    const records = await this.auditLog(limit)
    return records.map((record) => describeAuditRecord(record))
  }

  async verifyAuditChain(): Promise<{ ok: boolean; length: number; problems: readonly string[] }> {
    return await this.audit.verify()
  }

  private async appendAudit(
    action: PrintAuditAction,
    input: {
      readonly entityType: PrintAuditRecord['entityType']
      readonly entityId: string
      readonly reason?: string | null
      readonly context?: PrintAuditContext
      readonly values?: Record<string, string | number | boolean | null>
    }
  ): Promise<PrintAuditRecord> {
    const previous = await this.audit.last()
    const record = appendAuditRecord(previous, {
      id: this.idFactory('audit'),
      occurredAt: this.now(),
      action,
      entityType: input.entityType,
      entityId: input.entityId,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      context: { actorId: this.actorId, ...(input.context ?? {}) },
      ...(input.values === undefined ? {} : { values: input.values }),
    })
    await this.audit.append(record)
    return record
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  async diagnostics(): Promise<{
    templates: { published: number; ids: readonly string[] }
    profiles: number
    calibrations: number
    jobs: { total: number; staged: number }
    transport: string | null
    amountInWords: string
    policy: PrintPolicy
    audit: { ok: boolean; length: number }
  }> {
    const chain = await this.audit.verify()
    return {
      templates: { published: this.registry.size, ids: this.registry.ids() },
      profiles: await this.profiles.count(),
      calibrations: await this.calibrations.count(),
      jobs: { total: await this.jobs.count(), staged: this.staged.size },
      transport: this.transport?.id ?? null,
      amountInWords: this.amountInWords.id,
      policy: this.policy,
      audit: { ok: chain.ok, length: chain.length },
    }
  }

  get recordStore(): PrintingRecordStore {
    return this.store
  }

  get printTransport(): PrintTransport | null {
    return this.transport
  }

  get wordsConverter(): AmountInWordsConverter {
    return this.amountInWords
  }

  private resolveTemplate(templateId: string, version?: number): BankChequeTemplate {
    if (version !== undefined) {
      // Throws with the versions that do exist when a pinned one is gone — the alternative,
      // quietly substituting the newest layout, is the failure a reprint must never have.
      return this.registry.resolvePinned(templateId, version)
    }
    const template = this.registry.get(templateId)
    if (template === null) {
      throw new ChequePrintingError(
        `no published template "${templateId}" — publish it (or pick another stock) before printing`,
        'TEMPLATE_NOT_FOUND'
      )
    }
    return template
  }

  private async requireProfile(job: ChequePrintJob): Promise<PrinterProfile> {
    const profile = await this.getProfile(job.pin.printerProfileId)
    if (profile === null) {
      throw new ChequePrintingError(`printer profile "${job.pin.printerProfileId}" is missing`, 'PROFILE_NOT_FOUND')
    }
    return profile
  }
}

const stagedProfilePlaceholder: PrinterProfile = {
  id: '(deleted)',
  name: '(printer profile deleted after staging)',
  paperFeed: 'manual',
  orientation: 'landscape',
  duplex: 'none',
  nominalDpi: { x: 600, y: 600 },
  xOffsetMm: 0,
  yOffsetMm: 0,
  scale: { x: 1, y: 1 },
  unprintableMarginMm: { topMm: 0, rightMm: 0, bottomMm: 0, leftMm: 0 },
  supportsCustomPageSize: false,
  colourMode: 'mono',
  micrTonerCapable: false,
  createdAt: '',
  updatedAt: '',
}

/**
 * A job stores its layout, not the cheque, so a reprint re-renders the identical geometry. The
 * values below are only what the safety report needs to describe the job; nothing is invented.
 */
function stagedDataFrom(job: ChequePrintJob): ChequePrintData {
  const payeeRun = job.layout.runs.find((run) => run.fieldKey === 'payee')
  const amountRun = job.layout.runs.find((run) => run.fieldKey === 'amountNumeric')
  const data: ChequePrintData = {
    chequeId: job.chequeId,
    chequeNumber: job.chequeNumber,
    date: '',
    payeeName: payeeRun?.sourceText ?? '',
    amountDecimal: amountRun === undefined ? '' : amountRun.sourceText.replace(/[^\d.]/g, ''),
    currency: 'XXX',
    memo: null,
    reference: null,
    drawerName: null,
    drawerAddress: null,
    bankName: null,
    accountNumber: null,
  }
  return data
}

/**
 * A confirmation was given against the report the operator actually saw. If the issue set is
 * unchanged, the fresh report carries the same meaning and the confirmation applies to it; if a new
 * issue appeared, the confirmation is refused and the operator is told exactly what changed.
 */
function rebindConfirmation(
  confirmation: PrintConfirmation | null,
  staged: SafetyReport,
  fresh: SafetyReport
): PrintConfirmation | null {
  if (confirmation === null) return null
  if (confirmation.nonce === fresh.nonce) return confirmation
  // The confirmation has to have been given for THIS preview. Rebinding a tick that was never about
  // this job would let a confirmation be carried from one cheque to the next.
  if (confirmation.nonce !== staged.nonce) {
    throw new PrintBlockedError(
      'the confirmation was not given for this preview — its nonce matches neither the report the operator read nor the current one',
      [
        {
          code: 'SAFETY_CONFIRMATION_STALE',
          severity: 'error',
          message: `confirmation nonce ${confirmation.nonce} belongs to neither ${staged.nonce} nor ${fresh.nonce}`,
          remediation: 'show the current safety report and have the operator confirm it',
        },
      ],
      fresh.warnings
    )
  }
  const stagedCodes = staged.issues.map((issue) => `${issue.severity}:${issue.code}`).sort().join('|')
  const freshCodes = fresh.issues.map((issue) => `${issue.severity}:${issue.code}`).sort().join('|')
  if (stagedCodes === freshCodes) {
    // Same verdict, moved-on numbers (a re-measured calibration, a re-rendered document): the tick
    // stands, because the operator acknowledged exactly the issues that are still on the report.
    return Object.freeze({ ...confirmation, nonce: fresh.nonce })
  }
  throw new PrintBlockedError(
    'the safety situation changed between preview and authorisation; the warnings must be read again',
    [
      {
        code: 'SAFETY_REPORT_CHANGED',
        severity: 'error',
        message: `issue set changed: "${stagedCodes}" → "${freshCodes}"`,
        remediation: 're-run the preview and confirm the current report',
      },
    ],
    fresh.warnings
  )
}

function auditContext(
  job: ChequePrintJob,
  profile: PrinterProfile,
  calibration: PrinterCalibration | null,
  document: RenderedPrintDocument
): PrintAuditContext {
  return {
    jobId: job.id,
    chequeId: job.chequeId,
    chequeNumber: job.chequeNumber,
    templateId: job.pin.templateId,
    templateVersion: job.pin.templateVersion,
    templateHash: job.pin.templateHash,
    layoutHash: job.pin.layoutHash,
    printerProfileId: profile.id,
    calibrationId: calibration?.id ?? null,
    calibrationFingerprint: calibration === null ? null : calibrationFingerprint(calibration),
    attempt: job.attempt,
    isReprint: job.isReprint,
    documentBytes: document.bytes,
    documentHash: document.hash,
  }
}
