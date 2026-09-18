import { describe, expect, it, beforeEach } from 'vitest'
import {
  ChequePrintingError,
  InMemoryPrintingRecordStore,
  PRINTING_STORAGE_NAMESPACE,
  createConfirmation,
  documentFingerprint,
  type PrintConfirmation,
  type PrintResult,
  type PrintTransport,
  type RenderedPrintDocument,
  type SafetyReport,
} from '../../index'
import { PrintBlockedError } from '../../errors'
import type { PrintAuditRecord } from '../../printing/audit'
import type { ChequePrintJob } from '../../printing/PrintJob'
import type { MeasurementPoint } from '../../printer/calibration'
import { builtinTemplateById } from '../../template'
import { createChequePrintData } from '../../printdata'
import { ChequePrintingService, type StagedPrintJob } from '../ChequePrintingService'

const T0 = Date.UTC(2026, 8, 18, 9, 0, 0)
const ISO = (offsetMinutes: number): string => new Date(T0 + offsetMinutes * 60_000).toISOString()

/** A transport that records what it was given, as a spooler would. */
function fakeTransport(behaviour: 'ok' | 'silent' | 'throws' = 'ok'): {
  transport: PrintTransport
  submissions: { document: RenderedPrintDocument; job: ChequePrintJob }[]
} {
  const submissions: { document: RenderedPrintDocument; job: ChequePrintJob }[] = []
  return {
    submissions,
    transport: {
      id: 'fake-transport',
      label: 'Fake transport (test)',
      supportsOutcomeFeedback: behaviour !== 'silent',
      async submit(document, job): Promise<PrintResult> {
        if (behaviour === 'throws') throw new Error('the printer is offline')
        submissions.push({ document, job })
        return {
          jobId: job.id,
          documentBytes: document.bytes,
          documentHash: document.hash,
          pages: 1,
          submittedAt: ISO(1),
          transport: 'fake-transport',
          // The whole point of the flag: a browser transport cannot know that the paper came out.
          outcomeObserved: behaviour === 'ok',
        }
      },
    },
  }
}

const words = (value: string) => ({
  id: 'test-words',
  supportedLocales: ['en', 'ar'],
  convert: (request: { uppercase?: boolean }): {
    words: string
    converterId: string
    usedLocale: string
  } => ({
    words: request.uppercase === true ? value.toUpperCase() : value,
    converterId: 'test-words',
    usedLocale: 'en-EG',
  }),
})

const MEASUREMENTS: readonly MeasurementPoint[] = [
  { id: 'R1', expectedXMm: 8, expectedYMm: 8, measuredXMm: 8.6, measuredYMm: 7.4 },
  { id: 'R2', expectedXMm: 202, expectedYMm: 8, measuredXMm: 202.6, measuredYMm: 7.4 },
  { id: 'R3', expectedXMm: 202, expectedYMm: 77, measuredXMm: 202.6, measuredYMm: 76.4 },
  { id: 'R4', expectedXMm: 8, expectedYMm: 77, measuredXMm: 8.6, measuredYMm: 76.4 },
]

/** The same stock measured further along the sheet: different numbers, same verdict. */
const WIDER_MEASUREMENTS: readonly MeasurementPoint[] = MEASUREMENTS.map((point) => ({
  ...point,
  measuredXMm: point.measuredXMm + 0.9,
}))

/** Everything the NBE personal stock prints, so no field is left blank on purpose. */
const data = (): ReturnType<typeof createChequePrintData> =>
  createChequePrintData({
    chequeId: 'cheque-1',
    chequeNumber: '001234',
    date: '2026-09-18',
    payeeName: 'Crescent Trading LLC',
    amountDecimal: '1500.00',
    currency: 'EGP',
    memo: 'Invoice 2026-041',
    drawerName: 'H. Sobhy',
    bankName: 'National Bank of Egypt',
    custom: { branchCode: '1234' },
  })

let clock: number
let store: InMemoryPrintingRecordStore
let transport: ReturnType<typeof fakeTransport>

function service(
  overrides: Partial<ConstructorParameters<typeof ChequePrintingService>[0]> = {}
): ChequePrintingService {
  const counters = new Map<string, number>()
  return new ChequePrintingService({
    store,
    transport: transport.transport,
    amountInWords: words('one thousand five hundred pounds only'),
    now: () => ISO(clock),
    actorId: 'teller-1',
    idFactory: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${kind}-${String(next)}`
    },
    ...overrides,
  })
}

const actions = async (svc: ChequePrintingService): Promise<string[]> =>
  (await svc.auditLog()).map((record) => record.action)

/** A profile, its calibration, and one job staged and ready to authorise. */
async function stagedJob(
  svc: ChequePrintingService,
  profileOverrides: Record<string, unknown> = {}
): Promise<StagedPrintJob> {
  await svc.saveProfile({
    id: 'hp',
    name: 'Office LaserJet',
    supportsCustomPageSize: true,
    micrTonerCapable: true,
    ...profileOverrides,
  })
  await svc.calibrateFromMeasurements({
    printerProfileId: 'hp',
    templateId: 'nbe-personal-en-2024',
    templateVersion: 1,
    points: MEASUREMENTS,
    measuredBy: 'teller-1',
  })
  return await svc.stage({ templateId: 'nbe-personal-en-2024', data: data(), printerProfileId: 'hp' })
}

/** What the confirmation dialog hands back: the exact codes on the report the operator read. */
const confirm = (
  staged: { readonly safety: SafetyReport },
  actorId = 'manager-1'
): PrintConfirmation => createConfirmation(staged.safety, actorId, staged.safety.acknowledgementsRequired, ISO(1))

beforeEach(() => {
  clock = 0
  store = new InMemoryPrintingRecordStore()
  transport = fakeTransport()
})

describe('service construction and seeding', () => {
  it('knows the shipped bank stocks out of the box', () => {
    const svc = service()
    // Ordered by id, so the designer list does not reshuffle between loads.
    expect(svc.listTemplates().map((template) => template.id).sort()).toEqual([
      'cib-corporate-en-2023',
      'nbe-personal-ar-2024',
      'nbe-personal-en-2024',
      'nbe-voucher-a4-3part',
    ])
    expect(svc.getTemplate('nbe-personal-en-2024')?.version).toBe(1)
    expect(svc.listTemplates('bank:cib').map((template) => template.id)).toEqual(['cib-corporate-en-2023'])
  })

  it('can start empty, which is what an install with no shipped stock looks like', () => {
    const svc = service({ seedBuiltins: false })
    expect(svc.listTemplates()).toEqual([])
    expect(svc.getTemplate('nbe-personal-en-2024')).toBeNull()
  })

  it('reports what it is wired to', async () => {
    const svc = service()
    expect(await svc.diagnostics()).toEqual({
      templates: {
        published: 4,
        ids: ['cib-corporate-en-2023', 'nbe-personal-ar-2024', 'nbe-personal-en-2024', 'nbe-voucher-a4-3part'],
      },
      profiles: 0,
      calibrations: 0,
      jobs: { total: 0, staged: 0 },
      transport: 'fake-transport',
      amountInWords: 'test-words',
      policy: expect.objectContaining({ requireCalibration: true, blockOnWarnings: false }),
      audit: { ok: true, length: 0 },
    })
  })

  it('exposes the seams the app needs, without letting it reach past them', () => {
    const svc = service()
    expect(svc.recordStore).toBe(store)
    expect(svc.printTransport?.id).toBe('fake-transport')
    expect(svc.wordsConverter.id).toBe('test-words')
    expect(svc.registry.size).toBe(4)
  })

  it('loads persisted records and reports the counts it found', async () => {
    const first = service()
    await first.saveProfile({ id: 'hp', name: 'Office LaserJet', supportsCustomPageSize: true })
    expect(await first.load()).toEqual({ templates: 0, profiles: 1, calibrations: 0, jobs: 0 })
    // One key per record — including the audit trail, which is never rewritten as a collection.
    expect(await store.keys()).toEqual([
      `${PRINTING_STORAGE_NAMESPACE}:audit:00000001`,
      `${PRINTING_STORAGE_NAMESPACE}:profile:hp`,
    ])
    expect(first.registry.ids()).toEqual([
      'cib-corporate-en-2023',
      'nbe-personal-ar-2024',
      'nbe-personal-en-2024',
      'nbe-voucher-a4-3part',
    ])
  })
})

describe('templates through the service', () => {
  it('publishes a valid template, stores it, and reads it back after a restart', async () => {
    const svc = service({ seedBuiltins: false })
    const draft = svc.createTemplate({
      id: 'my-stock',
      bankId: 'bank:me',
      bankName: 'My Bank',
      name: 'My cheque',
      stockType: 'personal',
      paper: {
        widthMm: 190,
        heightMm: 80,
        orientation: 'landscape',
        bodyOriginMm: { xMm: 0, yMm: 0 },
        bodyWidthMm: 190,
        bodyHeightMm: 80,
      },
      fields: [
        { id: 'payee', key: 'payee', label: 'Payee', xMm: 10, yMm: 30, widthMm: 100, heightMm: 8, source: 'payeeName' },
      ],
    })
    const report = await svc.publishTemplate(draft)
    expect(report.createdVersion).toBe(1)
    expect(svc.getTemplate('my-stock')?.name).toBe('My cheque')
    expect(await actions(svc)).toEqual(['template.published'])

    const reloaded = service({ seedBuiltins: false })
    expect((await reloaded.load()).templates).toBe(1)
    expect(reloaded.getTemplate('my-stock')?.templateHash).toBe(draft.templateHash)
  })

  it('refuses to publish a template that does not validate, and names the rule it broke', async () => {
    const svc = service({ seedBuiltins: false })
    const broken = svc.createTemplate({
      id: 'broken',
      bankId: 'bank:me',
      bankName: 'My Bank',
      name: 'Broken',
      stockType: 'personal',
      paper: {
        widthMm: 190,
        heightMm: 80,
        orientation: 'landscape',
        bodyOriginMm: { xMm: 0, yMm: 0 },
        bodyWidthMm: 190,
        bodyHeightMm: 80,
      },
      fields: [],
    })
    expect(svc.inspectTemplate(broken).errors.map((issue) => issue.code)).toContain('NO_FIELDS')
    await expect(svc.publishTemplate(broken)).rejects.toThrow(/is not printable — 1 error\(s\): NO_FIELDS/)
    expect(svc.listTemplates()).toEqual([])
    expect(await actions(svc)).toEqual([])
  })

  it('revises by publishing a new version, keeping the old one resolvable for reprints', async () => {
    const svc = service()
    const v1 = svc.getTemplate('cib-corporate-en-2023')!
    const v2 = await svc.reviseTemplate('cib-corporate-en-2023', { name: 'CIB corporate, wider payee box' })
    expect(v2.version).toBe(2)
    expect(svc.getTemplate('cib-corporate-en-2023', 1)?.templateHash).toBe(v1.templateHash)
    expect(svc.getTemplate('cib-corporate-en-2023')?.version).toBe(2)
    expect(await actions(svc)).toEqual(['template.versioned'])
  })

  it('lets a revision be looked at before it is published', async () => {
    const svc = service()
    const candidate = await svc.reviseTemplate('nbe-personal-en-2024', { name: 'Draft name' }, { publish: false })
    expect(candidate.version).toBe(2)
    expect(svc.getTemplate('nbe-personal-en-2024')?.version).toBe(1)
    expect(await actions(svc)).toEqual([])
  })

  it('refuses to revise an unknown template, and refuses a revision that changes nothing', async () => {
    const svc = service()
    await expect(svc.reviseTemplate('nope', { name: 'x' })).rejects.toThrow(/no published template/)
    await expect(svc.reviseTemplate('nbe-personal-en-2024', {})).rejects.toThrow(/no content change/)
  })

  it('activates and deactivates a stock, which is how a retired leaflet is retired', async () => {
    const svc = service()
    await svc.setTemplateActive('nbe-personal-en-2024', 1, false)
    expect(svc.getTemplate('nbe-personal-en-2024')?.isActive).toBe(false)
    expect(svc.listTemplates()).toHaveLength(3)
    expect(await actions(svc)).toEqual(['template.deactivated'])
    await svc.setTemplateActive('nbe-personal-en-2024', 1, true)
    expect(svc.listTemplates()).toHaveLength(4)
  })
})

describe('profiles, test pages and calibration', () => {
  it('stores a profile and refuses an unusable one', async () => {
    const svc = service()
    const profile = await svc.saveProfile({
      id: 'hp',
      name: 'Office LaserJet',
      nominalDpi: { x: 600, y: 600 },
      supportsCustomPageSize: true,
    })
    expect(profile.createdAt).toBe(ISO(0))
    expect(profile.id).toBe('hp')
    expect(await svc.listProfiles()).toHaveLength(1)
    await expect(svc.saveProfile({ id: 'bad', name: '   ' })).rejects.toThrow(/is not usable/)
    await expect(svc.saveProfile({ id: 'wider', name: 'Wider', xOffsetMm: 40 })).rejects.toThrow(
      /is too large to be a device offset/
    )
    expect(await svc.listProfiles()).toHaveLength(1)
    expect(await svc.getProfile('ghost')).toBeNull()
  })

  it('generates a test page for one printer and one stock, and records that it was generated', async () => {
    const svc = service()
    await svc.saveProfile({ id: 'hp', name: 'Office LaserJet', supportsCustomPageSize: true })
    const page = await svc.generateTestPage({ profileId: 'hp', templateId: 'nbe-personal-en-2024', measuredAt: ISO(0) })
    expect(page.spec.id).toBe('testpage:hp:nbe-personal-en-2024:v1')
    expect(page.spec.paper).toEqual({ widthMm: 210, heightMm: 85 })
    expect(page.spec.calibrated).toBe(false)
    expect(page.spec.marks.filter((mark) => mark.kind === 'registration')).toHaveLength(5)
    expect(page.spec.marks.some((mark) => mark.kind === 'field-anchor')).toBe(true)
    expect(page.html).toContain('@page { size: 210mm 85mm; margin: 0mm; }')
    expect(page.bytes).toBe(new TextEncoder().encode(page.html).length)
    // The first page carries the raw template geometry, and says so: reading it as a measurement
    // would double-count the offsets the operator is about to measure.
    expect(page.spec.instructions.join('\n')).toContain('This page carries no transform at all')
    expect(page.spec.marks.every((mark) => mark.placedXMm === mark.expectedXMm && mark.placedYMm === mark.expectedYMm)).toBe(true)
    const record = (await svc.auditLog()).at(-1)
    expect(record?.action).toBe('testprint.generated')
    expect(record?.values).toMatchObject({ calibrated: false })
  })

  it('generates the second test page through the calibration it just measured', async () => {
    const svc = service()
    await svc.saveProfile({ id: 'hp', name: 'Office LaserJet', supportsCustomPageSize: true })
    await svc.calibrateFromMeasurements({
      printerProfileId: 'hp',
      templateId: 'nbe-personal-en-2024',
      templateVersion: 1,
      points: MEASUREMENTS,
    })
    const page = await svc.generateTestPage({
      profileId: 'hp',
      templateId: 'nbe-personal-en-2024',
      useCurrentCalibration: true,
    })
    expect(page.spec.calibrated).toBe(true)
    // The page is drawn pre-shifted by exactly the measured correction, so the printer's own drift
    // cancels it and the marks land where the template says they should.
    for (const mark of page.spec.marks.filter((entry) => entry.kind === 'registration')) {
      expect(mark.placedXMm - mark.expectedXMm).toBeCloseTo(0.6, 6)
      expect(mark.placedYMm - mark.expectedYMm).toBeCloseTo(-0.6, 6)
    }
    expect(page.spec.instructions.join('\n')).toContain('carries the current transform')
  })

  it('refuses to build a test page for a profile that does not exist', async () => {
    const svc = service()
    await expect(svc.generateTestPage({ profileId: 'ghost', templateId: 'nbe-personal-en-2024' })).rejects.toThrow(
      /unknown printer profile/
    )
  })

  it('derives a calibration from measurements and stores it against the pair', async () => {
    const svc = service()
    await svc.saveProfile({ id: 'hp', name: 'Office LaserJet', supportsCustomPageSize: true })
    const calibration = await svc.calibrateFromMeasurements({
      printerProfileId: 'hp',
      templateId: 'nbe-personal-en-2024',
      templateVersion: 1,
      points: MEASUREMENTS,
      testPageHash: 'page-hash',
    })
    expect(calibration.id).toBe('cal_hp::nbe-personal-en-2024')
    expect(calibration.offsetXMm).toBe(0.6)
    expect(calibration.offsetYMm).toBe(-0.6)
    expect(calibration.confidence).toBe('verified')
    expect(calibration.sourceTestPageHash).toBe('page-hash')
    expect(await svc.findCalibration('hp', 'nbe-personal-en-2024')).toMatchObject({ id: calibration.id })
    expect(await svc.findCalibration('hp', 'some-other-stock')).toBeNull()
    expect(await actions(svc)).toEqual(['profile.created', 'calibration.recorded'])
  })

  it('does not store an implausible correction, whatever the operator typed', async () => {
    const svc = service()
    await svc.saveProfile({ id: 'hp', name: 'Office LaserJet', supportsCustomPageSize: true })
    await expect(
      svc.recordCalibration({
        id: 'cal-bad',
        printerProfileId: 'hp',
        templateId: 'nbe-personal-en-2024',
        templateVersion: 1,
        offsetXMm: 25,
        offsetYMm: 0,
        method: 'manual-ruler',
      })
    ).rejects.toThrow(/refusing to store an implausible calibration/)
    expect(await svc.listCalibrations()).toEqual([])
  })

  it('can be told to keep a wild measurement anyway, because the operator may be diagnosing a fault', async () => {
    const svc = service()
    await svc.saveProfile({ id: 'hp', name: 'Office LaserJet', supportsCustomPageSize: true })
    const kept = await svc.recordCalibration({
      id: 'cal-bad',
      printerProfileId: 'hp',
      templateId: 'nbe-personal-en-2024',
      templateVersion: 1,
      offsetXMm: 25,
      offsetYMm: 0,
      method: 'manual-ruler',
      rejectIfInvalid: false,
    })
    expect(kept.id).toBe('cal-bad')
    expect((await svc.listCalibrations()).map((entry) => entry.id)).toEqual(['cal-bad'])
  })

  it('promotes a draft calibration to verified only through the verification step', async () => {
    const svc = service()
    await svc.saveProfile({ id: 'hp', name: 'Office LaserJet', supportsCustomPageSize: true })
    const draft = await svc.calibrateFromMeasurements({
      printerProfileId: 'hp',
      templateId: 'nbe-personal-en-2024',
      templateVersion: 1,
      points: MEASUREMENTS.slice(0, 2),
    })
    expect(draft.confidence).toBe('draft')
    // A draft still counts as a calibration for the gate — it is measured, only thinly.
    const verified = await svc.verifyCalibration(draft.id)
    expect(verified.confidence).toBe('verified')
    expect((await svc.findCalibration('hp', 'nbe-personal-en-2024'))?.confidence).toBe('verified')
    expect(await actions(svc)).toEqual(['profile.created', 'calibration.recorded', 'calibration.verified'])
    await expect(svc.verifyCalibration('nope')).rejects.toThrow(/unknown calibration/)
  })

  it('refuses a two-point calibration when the operator asked for a measured one', async () => {
    const svc = service()
    await svc.saveProfile({ id: 'hp', name: 'Office LaserJet', supportsCustomPageSize: true })
    await expect(
      svc.calibrateFromMeasurements({
        printerProfileId: 'hp',
        templateId: 'nbe-personal-en-2024',
        templateVersion: 1,
        points: MEASUREMENTS.slice(0, 2),
        rejectIfImplausible: true,
      })
    ).rejects.toThrow(/is a draft: measure at least three marks/)
    expect(await svc.listCalibrations()).toEqual([])
  })
})

describe('preview', () => {
  it('lays the cheque out without needing a printer at all', async () => {
    const svc = service()
    const preview = await svc.preview({ templateId: 'nbe-personal-en-2024', data: data() })
    expect(preview.profile).toBeNull()
    expect(preview.safety).toBeNull()
    expect(preview.layout.runCount).toBeGreaterThan(2)
    expect(preview.layout.templateHash).toBe(builtinTemplateById('nbe-personal-en-2024')?.templateHash)
    // Preview-only boxes are carried for the on-screen sheet, and never reach the printer (rule T5).
    expect(preview.layout.guides.length).toBeGreaterThan(0)
  })

  it('renders the words line through the injected converter, not a private table', async () => {
    const svc = service()
    const preview = await svc.preview({ templateId: 'nbe-personal-en-2024', data: data() })
    const wordsRun = preview.layout.runs.find((run) => run.fieldKey === 'amountWords')
    // The stock prints the words line in capitals, and the request carries that to the converter.
    expect(wordsRun?.sourceText).toBe('ONE THOUSAND FIVE HUNDRED POUNDS ONLY')
    expect(wordsRun?.text).toBe('ONE THOUSAND FIVE HUNDRED POUNDS ONLY')
  })

  it('refuses to invent a words line when no converter is wired', async () => {
    const svc = service({ amountInWords: undefined })
    const preview = await svc.preview({ templateId: 'nbe-personal-en-2024', data: data() })
    const failure = preview.layout.warnings.find((issue) => issue.code === 'FIELD_WORDS_RENDER_FAILED')
    expect(failure?.severity).toBe('error')
    expect(preview.layout.blocked).toBe(true)
    const wordsRun = preview.layout.runs.find((run) => run.fieldKey === 'amountWords')
    expect(wordsRun?.sourceText ?? '').toBe('')
  })

  it('adds the device view when a printer is named', async () => {
    const svc = service()
    await svc.saveProfile({ id: 'hp', name: 'Office LaserJet', supportsCustomPageSize: true })
    const preview = await svc.preview({ templateId: 'nbe-personal-en-2024', data: data(), printerProfileId: 'hp' })
    expect(preview.calibration).toBeNull()
    expect(preview.safety?.blocked).toBe(true)
    expect(preview.safety?.errors.map((issue) => issue.code)).toContain('CALIBRATION_MISSING')
  })

  it('normalises print data at the edge, so the UI can hand over a raw form object', () => {
    const svc = service()
    const normalised = svc.normalizePrintData({
      chequeNumber: '0007',
      date: '2026-09-18',
      payeeName: 'Acme',
      amountDecimal: '1500.1',
      currency: 'egp',
    })
    expect(normalised.currency).toBe('EGP')
    expect(normalised.amountDecimal).toBe('1500.1')
    expect(() =>
      svc.normalizePrintData({
        chequeNumber: '0007',
        date: '2026-09-18',
        payeeName: '   ',
        amountDecimal: '1',
        currency: 'EGP',
      })
    ).toThrow(TypeError)
  })
})

describe('the print flow: stage → authorise → send → complete', () => {
  it('walks the whole flow and lands a completed, verifiable record', async () => {
    const svc = service()
    const staged = await stagedJob(svc)
    const { job } = staged
    expect(job.status).toBe('queued')
    expect(job.pin).toMatchObject({
      templateId: 'nbe-personal-en-2024',
      templateVersion: 1,
      printerProfileId: 'hp',
      calibrationId: 'cal_hp::nbe-personal-en-2024',
    })
    expect(job.pin.layoutHash).toBe(staged.layout.layoutHash)
    expect(job.document.bytes).toBe(staged.document.bytes)
    // The stock carries a pre-printed MICR band, so the operator is told what is not being printed.
    expect(staged.safety.acknowledgementsRequired).toEqual(['MICR_TONER_DECLARED'])
    // Staging alone persists nothing.
    expect(await svc.diagnostics()).toMatchObject({ jobs: { total: 0, staged: 1 } })

    const { job: sent, result } = await svc.authorise({
      jobId: job.id,
      actorId: 'manager-1',
      reason: 'checked against the invoice',
      confirmation: confirm(staged),
    })
    expect(sent.status).toBe('sent')
    expect(sent.authorizedBy).toBe('manager-1')
    expect(sent.authorizationReason).toBe('checked against the invoice')
    expect(result).toMatchObject({ pages: 1, outcomeObserved: true, transport: 'fake-transport' })
    expect(transport.submissions).toHaveLength(1)
    // The transport is handed the rendered document; the record keeps only a fingerprint it can
    // re-derive without the HTML — deliberately different artefacts, deliberately both checkable.
    expect(transport.submissions[0]?.document.hash).toBe(staged.document.hash)
    expect(sent.document).toEqual({
      ...documentFingerprint(staged.document.html, staged.document.runCount),
      mimeType: 'text/html',
      runCount: staged.document.runCount,
    })

    const completed = await svc.complete(sent.id, 'teller-1')
    expect(completed.status).toBe('completed')
    expect(completed.history.map((event) => event.status)).toEqual([
      'created',
      'queued',
      'authorised',
      'rendering',
      'sent',
      'completed',
    ])
    expect((await svc.verifyJob(completed.id)).ok).toBe(true)
    expect(await svc.diagnostics()).toMatchObject({
      profiles: 1,
      calibrations: 1,
      jobs: { total: 1, staged: 0 },
      audit: { ok: true, length: 8 },
    })
  })

  it('writes an audit trail that verifies end to end', async () => {
    const svc = service()
    const staged = await stagedJob(svc)
    await svc.authorise({ jobId: staged.job.id, actorId: 'manager-1', reason: 'invoice checked', confirmation: confirm(staged) })
    await svc.complete(staged.job.id, 'teller-1')
    const log = await svc.auditLog()
    expect(log.map((record) => record.action)).toEqual([
      'profile.created',
      'calibration.recorded',
      'job.created',
      'safety.acknowledged',
      'job.authorised',
      'job.rendered',
      'job.sent',
      'job.completed',
    ])
    expect(log.map((record) => record.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(log.every((record) => record.context.actorId === 'teller-1')).toBe(true)
    expect(log.find((record) => record.action === 'safety.acknowledged')?.reason).toBe('acknowledged: MICR_TONER_DECLARED')
    const sent = log.find((record) => record.action === 'job.sent')!
    expect(sent.values).toMatchObject({ pages: 1, outcomeObserved: true })
    expect(sent.context.layoutHash).toBe(staged.job.layout.layoutHash)
    expect(await svc.verifyAuditChain()).toMatchObject({ ok: true, length: 8 })
    expect((await svc.auditSummary(2)).map((line) => line.slice(0, 4))).toEqual(['0007', '0008'])
  })

  it('refuses to authorise a job it has not staged, and refuses to stage against a missing printer', async () => {
    const svc = service()
    await expect(svc.authorise({ jobId: 'nope', actorId: 'manager-1' })).rejects.toThrow(/is not staged/)
    await expect(svc.stage({ templateId: 'nbe-personal-en-2024', data: data(), printerProfileId: 'ghost' })).rejects.toThrow(
      /no printer profile "ghost"/
    )
  })

  it('refuses to stage a template that is not published', async () => {
    const svc = service()
    await svc.saveProfile({ id: 'hp', name: 'Office LaserJet', supportsCustomPageSize: true })
    await expect(svc.stage({ templateId: 'no-such-stock', data: data(), printerProfileId: 'hp' })).rejects.toThrow(
      /no published template/
    )
  })

  it('blocks the print before a job exists when safety says no, and records the refusal', async () => {
    const svc = service()
    await svc.saveProfile({ id: 'hp', name: 'Office LaserJet', supportsCustomPageSize: true })
    let caught: unknown
    try {
      await svc.stage({ templateId: 'nbe-personal-en-2024', data: data(), printerProfileId: 'hp' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PrintBlockedError)
    const blocked = caught as PrintBlockedError
    expect(blocked.code).toBe('PRINT_BLOCKED')
    expect(blocked.blockers.map((issue) => issue.code)).toContain('CALIBRATION_MISSING')
    expect((await svc.diagnostics()).jobs.staged).toBe(0)
    expect(await actions(svc)).toEqual(['profile.created', 'safety.blocked'])
  })

  it('refuses to send when the operator has not ticked the warnings', async () => {
    const svc = service()
    const { job } = await stagedJob(svc)
    await expect(svc.authorise({ jobId: job.id, actorId: 'manager-1' })).rejects.toThrow(
      /printing requires an explicit acknowledgement of: MICR_TONER_DECLARED/
    )
    expect((await svc.getJob(job.id)).status).toBe('queued')
  })

  it('lets an organisation print uncalibrated, but only by saying so in the policy', async () => {
    const svc = service({ policy: { requireCalibration: false } })
    await svc.saveProfile({ id: 'hp', name: 'Office LaserJet', supportsCustomPageSize: true })
    const staged = await svc.stage({ templateId: 'nbe-personal-en-2024', data: data(), printerProfileId: 'hp' })
    expect(staged.safety.ok).toBe(true)
    expect(staged.safety.acknowledgementsRequired).toContain('CALIBRATION_MISSING')
    await expect(svc.authorise({ jobId: staged.job.id, actorId: 'manager-1' })).rejects.toThrow(/explicit acknowledgement of/)
    const { job } = await svc.authorise({
      jobId: staged.job.id,
      actorId: 'manager-1',
      acknowledged: staged.safety.acknowledgementsRequired,
    })
    expect(job.status).toBe('sent')
    expect(job.pin.calibrationId).toBeNull()
  })

  it('splits the decision from the send, so a queue can send later', async () => {
    const svc = service()
    const staged = await stagedJob(svc)
    const rendering = await svc.authorise({
      jobId: staged.job.id,
      actorId: 'manager-1',
      sendNow: false,
      confirmation: confirm(staged),
    })
    expect(rendering.job.status).toBe('rendering')
    expect(rendering.result).toBeNull()
    expect(transport.submissions).toHaveLength(0)
    const sent = await svc.send(staged.job.id)
    expect(sent.job.status).toBe('sent')
    expect(transport.submissions).toHaveLength(1)
  })

  it('reports a missing transport without losing the document it built', async () => {
    const svc = service({ transport: null })
    const staged = await stagedJob(svc)
    const rendering = await svc.authorise({
      jobId: staged.job.id,
      actorId: 'manager-1',
      sendNow: false,
      confirmation: confirm(staged),
    })
    expect(rendering.job.status).toBe('rendering')
    let error: unknown
    try {
      await svc.send(staged.job.id)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ChequePrintingError)
    expect((error as ChequePrintingError).code).toBe('NO_PRINT_TRANSPORT')
    // The document survives, so the operator can print it once a transport is wired up. The job
    // itself carries only the fingerprint — never the HTML, which is what pinning is for.
    // The job carries only the fingerprint of the document — never the HTML itself.
    expect(rendering.job.document).toEqual(staged.job.document)
    expect(rendering.job.document.bytes).toBeGreaterThan(0)
    expect(staged.document.html).toContain('Crescent Trading LLC')
    expect(rendering.job.document.bytes).toBe(staged.document.bytes)
  })

  it('marks the job failed when the transport throws, and keeps the reason', async () => {
    transport = fakeTransport('throws')
    const svc = service()
    const staged = await stagedJob(svc)
    await expect(
      svc.authorise({ jobId: staged.job.id, actorId: 'manager-1', confirmation: confirm(staged) })
    ).rejects.toThrow(/printer is offline/)
    const failed = await svc.getJob(staged.job.id)
    expect(failed.status).toBe('failed')
    expect(failed.failure?.code).toBe('TRANSPORT_FAILED')
    expect(failed.failure?.message).toBe('the printer is offline')
    expect(await actions(svc)).toContain('job.failed')
    // The staged entry is gone, so a retry goes through the reprint path rather than a second click.
    expect((await svc.diagnostics()).jobs.staged).toBe(0)
    await expect(svc.authorise({ jobId: staged.job.id, actorId: 'manager-1' })).rejects.toThrow(/is not staged/)
  })

  it('keeps a job at sent when the transport cannot see the outcome, and lets a human complete it', async () => {
    transport = fakeTransport('silent')
    const svc = service()
    const staged = await stagedJob(svc)
    const { job: sent, result } = await svc.authorise({
      jobId: staged.job.id,
      actorId: 'manager-1',
      confirmation: confirm(staged),
    })
    expect(sent.status).toBe('sent')
    expect(result).toMatchObject({ outcomeObserved: false })
    expect(sent.completedAt).toBeNull()
    const completed = await svc.complete(sent.id, 'teller-1')
    expect(completed.status).toBe('completed')
    expect(completed.history.at(-1)?.actorId).toBe('teller-1')
  })

  it('cancels before the send, and refuses after it', async () => {
    const svc = service()
    const staged = await stagedJob(svc)
    const cancelled = await svc.cancel(staged.job.id, 'teller-1', 'wrong payee spelled')
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.history.at(-1)?.note).toBe('wrong payee spelled')
    expect((await svc.diagnostics()).jobs.staged).toBe(0)
    expect(await actions(svc)).toContain('job.cancelled')

    const second = await stagedJob(svc)
    await svc.authorise({ jobId: second.job.id, actorId: 'manager-1', confirmation: confirm(second) })
    await expect(svc.cancel(second.job.id, 'teller-1', 'too late')).rejects.toThrow(
      /cannot be cancelled — void the cheque instead/
    )
  })
})

describe('reprints', () => {
  it('reprints the stored layout, never the newest template, and demands a reason', async () => {
    const svc = service()
    const staged = await stagedJob(svc)
    await svc.authorise({ jobId: staged.job.id, actorId: 'manager-1', confirmation: confirm(staged) })
    await svc.complete(staged.job.id, 'teller-1')

    await expect(svc.reprint(staged.job.id, 'teller-1', '   ')).rejects.toThrow(/reprint requires a recorded reason/)

    const reprint = await svc.reprint(staged.job.id, 'teller-1', 'the sheet came out crooked')
    expect(reprint.job.isReprint).toBe(true)
    expect(reprint.job.attempt).toBe(1)
    expect(reprint.job.reprintOfJobId).toBe(staged.job.id)
    expect(reprint.job.pin.layoutHash).toBe(staged.job.pin.layoutHash)
    expect(reprint.job.layout.layoutHash).toBe(staged.job.layout.layoutHash)
    expect(reprint.job.document.hash).toBe(staged.job.document.hash)
    expect(reprint.safety.warnings.map((warning) => warning.code)).toContain('REPRINT')
    expect(reprint.job.notes).toBe('reprint of job-1: the sheet came out crooked')
  })

  it('counts the sheets already spent on the cheque number', async () => {
    const svc = service()
    const staged = await stagedJob(svc)
    await svc.authorise({ jobId: staged.job.id, actorId: 'manager-1', confirmation: confirm(staged) })
    await svc.complete(staged.job.id, 'teller-1')
    const first = await svc.reprint(staged.job.id, 'teller-1', 'crooked')
    await svc.authorise({
      jobId: first.job.id,
      actorId: 'manager-1',
      reason: 'the first sheet was jammed and torn out',
      confirmation: confirm(first),
    })
    await svc.complete(first.job.id, 'teller-1')
    const second = await svc.reprint(first.job.id, 'teller-1', 'toner smear')
    expect(second.job.attempt).toBe(2)
    expect(second.job.reprintOfJobId).toBe(first.job.id)
    // A sanctioned reprint is not reported as a suspected duplicate: the sheet count lives on the
    // job (attempt 2) and in the audit trail, where an auditor looks for it.
    expect(second.safety.warnings.map((warning) => warning.code)).toEqual(['MICR_TONER_DECLARED', 'REPRINT'])
    expect(second.safety.acknowledgementsRequired).toContain('REPRINT')
    expect((await svc.jobsForChequeNumber('001234')).map((entry) => entry.attempt).sort()).toEqual([0, 1, 2])
    const recent = await svc.recentJobs(5)
    expect(recent).toHaveLength(3)
    expect(recent.filter((entry) => entry.isReprint)).toHaveLength(2)
  })

  it('sends a reprint through the normal authorisation gate, reason included', async () => {
    const svc = service()
    const staged = await stagedJob(svc)
    await svc.authorise({ jobId: staged.job.id, actorId: 'manager-1', confirmation: confirm(staged) })
    await svc.complete(staged.job.id, 'teller-1')
    const reprinted = await svc.reprint(staged.job.id, 'teller-1', 'crooked')
    await expect(
      svc.authorise({ jobId: reprinted.job.id, actorId: 'manager-1', confirmation: confirm(reprinted) })
    ).rejects.toThrow(/a reprint needs a recorded reason/)
    const sent = await svc.authorise({
      jobId: reprinted.job.id,
      actorId: 'manager-1',
      reason: 'second sheet, first destroyed',
      confirmation: confirm(reprinted),
    })
    expect(sent.job.status).toBe('sent')
    expect(sent.job.authorizationReason).toBe('second sheet, first destroyed')
    expect(transport.submissions).toHaveLength(2)
    expect(transport.submissions[1]?.document.hash).toBe(transport.submissions[0]?.document.hash)
  })
})

describe('the safety gate between staging and sending', () => {
  it('refuses to send when the stock was retired after staging', async () => {
    const svc = service()
    const staged = await stagedJob(svc)
    await svc.setTemplateActive('nbe-personal-en-2024', 1, false)
    await expect(
      svc.authorise({ jobId: staged.job.id, actorId: 'manager-1', confirmation: confirm(staged) })
    ).rejects.toThrow(/print blocked by 1 error/)
    expect((await svc.getJob(staged.job.id)).status).toBe('queued')
  })

  it('accepts a confirmation whose report moved only on numbers the operator cannot act on', async () => {
    const svc = service()
    const staged = await stagedJob(svc)
    const confirmation = confirm(staged)
    // Re-measuring the same printer changes the fingerprint but not the verdict, so the tick stands.
    await svc.calibrateFromMeasurements({
      printerProfileId: 'hp',
      templateId: 'nbe-personal-en-2024',
      templateVersion: 1,
      points: WIDER_MEASUREMENTS,
    })
    const { job } = await svc.authorise({ jobId: staged.job.id, actorId: 'manager-1', confirmation })
    expect(job.status).toBe('sent')
    expect(job.pin.calibrationId).toBe('cal_hp::nbe-personal-en-2024')
  })

  it('refuses a confirmation whose report gained an issue the operator never saw', async () => {
    const svc = service()
    const staged = await stagedJob(svc, { micrTonerCapable: false })
    expect(staged.safety.acknowledgementsRequired).toEqual(['MICR_TONER_UNAVAILABLE'])
    const confirmation = confirm(staged)
    // Re-describing the printer as MICR-capable changes the warning, so the tick does not carry over.
    await svc.saveProfile({ id: 'hp', name: 'Office LaserJet', supportsCustomPageSize: true, micrTonerCapable: true })
    await expect(
      svc.authorise({ jobId: staged.job.id, actorId: 'manager-1', confirmation })
    ).rejects.toThrow(/safety situation changed between preview and authorisation/)
  })

  it('refuses a confirmation given against a different report', async () => {
    const svc = service()
    const staged = await stagedJob(svc)
    await expect(
      svc.authorise({
        jobId: staged.job.id,
        actorId: 'manager-1',
        confirmation: { nonce: 'some-other-report', acknowledged: ['MICR_TONER_DECLARED'], actorId: 'manager-1', confirmedAt: ISO(1) },
      })
    ).rejects.toThrow(/not given for this preview/)
  })

  it('refuses a confirmation that acknowledges the wrong warning', async () => {
    const svc = service()
    const staged = await stagedJob(svc)
    await expect(
      svc.authorise({
        jobId: staged.job.id,
        actorId: 'manager-1',
        confirmation: { nonce: staged.safety.nonce, acknowledged: ['CALIBRATION_MISSING'], actorId: 'manager-1', confirmedAt: ISO(1) },
      })
    ).rejects.toThrow(/unacknowledged safety warnings: MICR_TONER_DECLARED/)
  })

  it('refuses a confirmation that does not say who gave it', async () => {
    const svc = service()
    const staged = await stagedJob(svc)
    await expect(
      svc.authorise({
        jobId: staged.job.id,
        actorId: 'manager-1',
        confirmation: { nonce: staged.safety.nonce, acknowledged: ['MICR_TONER_DECLARED'], actorId: '   ', confirmedAt: ISO(1) },
      })
    ).rejects.toThrow(/a confirmation must name who gave it/)
  })
})

describe('records survive a restart', () => {
  it('reads a job back from the store and still verifies it', async () => {
    const svc = service()
    const staged = await stagedJob(svc)
    await svc.authorise({ jobId: staged.job.id, actorId: 'manager-1', confirmation: confirm(staged) })
    await svc.complete(staged.job.id, 'teller-1')

    const reopened = service()
    const restored = await reopened.getJob(staged.job.id)
    expect(restored.status).toBe('completed')
    expect(restored.pin).toEqual(staged.job.pin)
    expect(restored.layout.layoutHash).toBe(staged.job.layout.layoutHash)
    expect((await reopened.verifyJob(staged.job.id)).ok).toBe(true)
    expect((await reopened.load()).jobs).toBe(1)
    expect(await reopened.verifyAuditChain()).toMatchObject({ ok: true, length: 8 })
    await expect(reopened.getJob('nope')).rejects.toThrow(/unknown print job/)
  })

  it('catches a job record whose contents were edited underneath it', async () => {
    const svc = service()
    const staged = await stagedJob(svc)
    await svc.authorise({ jobId: staged.job.id, actorId: 'manager-1', confirmation: confirm(staged) })
    const key = `${PRINTING_STORAGE_NAMESPACE}:job:job-1`
    const record = await store.get<{ id: string; updatedAt: string; job: ChequePrintJob }>(key)
    if (record === null) throw new Error('the job record was never persisted')
    await store.set(key, { ...record, job: { ...record.job, chequeNumber: '999999' } })

    const reopened = service()
    const restored = await reopened.getJob(staged.job.id)
    expect(restored.chequeNumber).toBe('999999')
    const result = await reopened.verifyJob(staged.job.id)
    expect(result.ok).toBe(false)
    expect(result.problems.join('\n')).toMatch(/record hash does not match its contents/)
  })

  it('catches a job record whose layout was swapped for another cheque', async () => {
    const svc = service()
    const staged = await stagedJob(svc)
    await svc.authorise({ jobId: staged.job.id, actorId: 'manager-1', confirmation: confirm(staged) })
    const key = `${PRINTING_STORAGE_NAMESPACE}:job:job-1`
    const record = await store.get<{ id: string; updatedAt: string; job: ChequePrintJob }>(key)
    if (record === null) throw new Error('the job record was never persisted')
    await store.set(key, {
      ...record,
      job: { ...record.job, layout: { ...record.job.layout, layoutHash: 'another-cheque' } },
    })
    const result = await service().verifyJob(staged.job.id)
    expect(result.ok).toBe(false)
    expect(result.problems.join('\n')).toContain('does not match the pinned layout')
  })

  it('will not let a version that a job pinned be deleted', async () => {
    const svc = service()
    const staged = await stagedJob(svc)
    await svc.authorise({ jobId: staged.job.id, actorId: 'manager-1', confirmation: confirm(staged) })
    const registry = svc.registry as unknown as { remove(templateId: string, version: number): void }
    expect(() => registry.remove('nbe-personal-en-2024', 1)).toThrow(/referenced by a print record/)
    expect(svc.getTemplate('nbe-personal-en-2024', 1)).not.toBeNull()
  })
})

describe('the audit log', () => {
  it('is append-only, ordered, and stores no cheque text', async () => {
    const svc = service()
    await svc.saveProfile({ id: 'hp', name: 'Office LaserJet', supportsCustomPageSize: true })
    const one = await svc.auditLog(1)
    expect(one).toHaveLength(1)
    expect((one[0] as PrintAuditRecord).action).toBe('profile.created')
    expect((await svc.auditLog()).map((record) => record.sequence)).toEqual([1])

    const staged = await stagedJob(svc)
    await svc.authorise({ jobId: staged.job.id, actorId: 'manager-1', confirmation: confirm(staged) })
    const dump = JSON.stringify(await svc.auditLog())
    expect(dump).not.toContain('Crescent Trading LLC')
    // The cheque number is attribution, and stays — it is what an auditor searches for.
    expect(dump).toContain('001234')
  })
})
