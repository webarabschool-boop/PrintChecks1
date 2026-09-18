/**
 * Shared fixtures for the printing suites. Kept out of the `.test.ts` glob so vitest never runs it
 * on its own; every value here is built through the real factories, never hand-assembled, so a test
 * cannot pass against a shape the engine would never produce.
 */
import { buildPrintLayout } from '../../layout/engine'
import { createChequePrintData, type ChequePrintData } from '../../printdata'
import { createPrinterCalibration } from '../../printer/calibration'
import { createPrinterProfile } from '../../printer/profile'
import type { CreateProfileInput, PrinterCalibration, PrinterProfile } from '../../printer/types'
import { createBankChequeTemplate, type BankChequeTemplate } from '../../template'
import type { PrintLayout } from '../../layout/types'

export const FIXED_AT = '2026-09-18T09:00:00.000Z'

export function fixtureTemplate(overrides: Partial<Parameters<typeof createBankChequeTemplate>[0]> = {}): BankChequeTemplate {
  return createBankChequeTemplate({
    id: 'nbe-personal-en-2024',
    bankId: 'bank:nbe',
    bankName: 'National Bank of Egypt',
    name: 'NBE personal cheque (English)',
    stockType: 'personal',
    paper: {
      widthMm: 210,
      heightMm: 85,
      orientation: 'landscape',
      bodyOriginMm: { xMm: 0, yMm: 0 },
      bodyWidthMm: 210,
      bodyHeightMm: 85,
    },
    fields: [
      {
        id: 'payee',
        key: 'payee',
        label: 'Pay to the order of',
        xMm: 12,
        yMm: 30,
        widthMm: 118,
        heightMm: 8,
        fontSizePt: 12,
        fontFamily: 'Times New Roman',
        source: 'payeeName',
        required: true,
      },
      {
        id: 'amount-numeric',
        key: 'amountNumeric',
        label: 'Amount',
        xMm: 150,
        yMm: 36,
        widthMm: 48,
        heightMm: 8,
        fontSizePt: 11,
        fontFamily: 'Times New Roman',
        source: 'amountDecimal',
        format: 'amount-2dp',
        alignment: { horizontal: 'right', vertical: 'middle' },
        required: true,
      },
      {
        id: 'micr-guide',
        key: 'micr',
        label: 'MICR band (pre-printed)',
        role: 'guide',
        xMm: 12,
        yMm: 72,
        widthMm: 170,
        heightMm: 9,
        isMicr: true,
        isPrinted: false,
        source: 'chequeNumber',
      },
    ],
    ...overrides,
  })
}

export function fixtureData(overrides: Partial<ChequePrintData> = {}): ChequePrintData {
  return createChequePrintData({
    chequeId: 'cheque-0001',
    chequeNumber: '001234',
    date: '2026-09-18',
    payeeName: 'Crescent Trading LLC',
    amountDecimal: '1500.00',
    currency: 'EGP',
    ...overrides,
  })
}

export function fixtureProfile(overrides: Partial<CreateProfileInput> = {}): PrinterProfile {
  return createPrinterProfile(
    {
      id: 'hp-m402',
      name: 'Office LaserJet',
      make: 'HP',
      model: 'LaserJet Pro M402dn',
      paperFeed: 'manual',
      nominalDpi: { x: 600, y: 600 },
      xOffsetMm: 0,
      yOffsetMm: 0,
      scale: { x: 1, y: 1 },
      unprintableMarginMm: { topMm: 4, rightMm: 4, bottomMm: 4, leftMm: 4 },
      supportsCustomPageSize: true,
      ...overrides,
    },
    FIXED_AT
  )
}

export function fixtureCalibration(overrides: Partial<PrinterCalibration> = {}): PrinterCalibration {
  return createPrinterCalibration(
    {
      id: 'cal-hp-nbe',
      printerProfileId: 'hp-m402',
      templateId: 'nbe-personal-en-2024',
      templateVersion: 1,
      offsetXMm: 0.4,
      offsetYMm: -0.2,
      scaleX: 1,
      scaleY: 1,
      method: 'test-page',
      confidence: 'verified',
      measuredAt: FIXED_AT,
      ...overrides,
    },
    FIXED_AT
  )
}

const words = (value: string) => ({
  id: 'fixture-converter',
  supportedLocales: ['en', 'ar'],
  convert: (request: { uppercase?: boolean }) => ({
    words: request.uppercase === true ? value.toUpperCase() : value,
    converterId: 'fixture-converter',
    usedLocale: 'en-EG',
  }),
})

export function fixtureLayout(
  options: {
    template?: BankChequeTemplate
    data?: ChequePrintData
    amountInWords?: string
  } = {}
): PrintLayout {
  return buildPrintLayout({
    template: options.template ?? fixtureTemplate(),
    data: options.data ?? fixtureData(),
    options:
      options.amountInWords === undefined ? {} : { amountInWords: words(options.amountInWords) },
  })
}
