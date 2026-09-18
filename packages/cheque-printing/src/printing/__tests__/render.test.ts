import { describe, expect, it } from 'vitest'
import { PrintBlockedError } from '../../errors'
import { roundMm } from '../../geometry/units'
import { buildPrintLayout } from '../../layout/engine'
import { createChequePrintData } from '../../printdata'
import { createPrinterCalibration, createPrinterProfile, createBankChequeTemplate, mmCss } from '../../index'
import { findForbiddenMarkup } from '../../html/document'
import { printedPositionOf, renderPrintDocument } from '../render'
import { fixtureCalibration, fixtureData, fixtureLayout, fixtureProfile, fixtureTemplate, FIXED_AT } from './fixture'
import type { BankChequeTemplate } from '../../template'

describe('rendering the print document', () => {
  const layout = fixtureLayout()
  const document = renderPrintDocument({ layout, profile: fixtureProfile() })
  // The payee run, and the line inside it: the box is the field, the line is what gets inked.
  const payee = layout.runs.find((entry) => entry.fieldId === 'payee')!
  const payeeLine = payee.lines[0]!

  it('declares the page as the physical stock, with no margin at all', () => {
    expect(document.pageWidthMm).toBe(210)
    expect(document.pageHeightMm).toBe(85)
    expect(document.marginMm).toBe(0)
    expect(document.html).toContain('@page { size: 210mm 85mm; margin: 0mm; }')
    expect(document.html).toContain('body { width: 210mm; height: 85mm;')
  })

  it('is a standalone, inert, offline document', () => {
    expect(document.html).toContain('<!DOCTYPE html>')
    expect(document.html).toContain('<meta charset="utf-8" />')
    expect(document.mimeType).toBe('text/html')
    expect(document.encoding).toBe('utf-8')
    expect(document.html).not.toContain('<script')
    expect(document.html).not.toContain('<link')
    expect(document.html).not.toContain('@import')
    expect(findForbiddenMarkup(document.html)).toEqual([])
  })

  it('emits one absolutely positioned element per printed line', () => {
    const divs = document.html.match(/<div class="pc-run"/g) ?? []
    expect(divs).toHaveLength(layout.runs.filter((entry) => entry.text.trim() !== '').length)
    expect(document.html).toContain(`left:${mmCss(payeeLine.xMm)}`)
    expect(document.html).toContain(`top:${mmCss(payeeLine.yMm)}`)
    expect(document.html).toContain(`width:${mmCss(payeeLine.widthMm)}`)
    expect(document.html).toContain(`height:${mmCss(payeeLine.heightMm)}`)
    expect(document.html).toContain('white-space:pre')
    expect(document.html).toContain('position:absolute')
  })

  it('says which field each piece of ink came from, and in which direction', () => {
    expect(document.html).toContain('data-field="payee"')
    expect(document.html).toContain('data-field="amount-numeric"')
    expect(document.html).toContain('dir="ltr"')
    expect(document.html).toContain('lang="en"')
  })

  it('carries the identity of the layout it was rendered from', () => {
    const layout = fixtureLayout()
    expect(document.layoutHash).toBe(layout.layoutHash)
    expect(document.templateId).toBe(layout.templateId)
    expect(document.templateVersion).toBe(layout.templateVersion)
    expect(document.html).toContain(`data-layout-hash="${layout.layoutHash}"`)
    expect(document.html).toContain('data-document-kind="cheque-print-data"')
    expect(document.html).toContain(`data-run-count="${document.runCount}"`)
    expect(document.bytes).toBe(new TextEncoder().encode(document.html).length)
    expect(document.hash.length).toBeGreaterThan(8)
  })

  it('hashes the same bytes to the same hash, and different bytes to a different one', () => {
    const again = renderPrintDocument({ layout: fixtureLayout(), profile: fixtureProfile() })
    expect(again.hash).toBe(document.hash)
    const other = renderPrintDocument({
      layout: fixtureLayout({ data: fixtureData({ payeeName: 'Crescent Trading LLC.' }) }),
      profile: fixtureProfile(),
    })
    expect(other.hash).not.toBe(document.hash)
  })

  it('sizes type in points, never pixels, and never in percentages', () => {
    expect(document.html).toContain('font-size:12pt')
    expect(document.html).not.toMatch(/font-size:[^;]*px/)
    expect(document.html).not.toMatch(/:\s*\d+px/)
    expect(document.html).not.toContain('vh')
    expect(document.html).not.toContain('vw')
  })

  it('keeps colour flat black on white, because a colour profile is not our business', () => {
    expect(document.html).toContain('color:#000000')
    expect(document.html).toContain('background: #ffffff')
    expect(document.html).not.toContain('background-image')
  })

  it('escapes the payee, so a name cannot inject markup', () => {
    const risky = fixtureLayout({ data: fixtureData({ payeeName: '<img src=x onerror=alert(1)>' }) })
    const html = renderPrintDocument({ layout: risky, profile: fixtureProfile() }).html
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img')
    expect(findForbiddenMarkup(html)).toEqual([])
  })
})

describe('the print document applies the device transform, and nothing else', () => {
  it('moves the ink by the profile offset and the calibration offset', () => {
    const layout = fixtureLayout()
    const profile = fixtureProfile({ xOffsetMm: 2, yOffsetMm: -1.5 })
    const calibration = fixtureCalibration({ offsetXMm: 0.5, offsetYMm: 0.25 })
    const payeeLine = layout.runs.find((entry) => entry.fieldId === 'payee')!.lines[0]!
    const plain = renderPrintDocument({ layout, profile: fixtureProfile() }).html
    const moved = renderPrintDocument({ layout, profile, calibration }).html
    expect(moved).toContain(`left:${mmCss(roundMm(payeeLine.xMm + 2.5))}`)
    expect(moved).toContain(`top:${mmCss(roundMm(payeeLine.yMm - 1.25))}`)
    expect(plain).toContain(`left:${mmCss(payeeLine.xMm)}`)
    expect(moved).not.toBe(plain)
  })

  it('scales both position and size when the calibration carries a scale correction', () => {
    const layout = fixtureLayout()
    const amount = layout.runs.find((entry) => entry.fieldId === 'amount-numeric')!
    const amountLine = amount.lines[0]!
    const calibration = fixtureCalibration({ offsetXMm: 0, offsetYMm: 0, scaleX: 1.01, scaleY: 1.01 })
    const html = renderPrintDocument({ layout, profile: fixtureProfile(), calibration }).html
    // The right-aligned amount line keeps its right edge against the pre-printed box, so it is the
    // line's own x that moves — 1% of it, in millimetres, with no DPI anywhere.
    expect(html).toContain(`left:${mmCss(roundMm(amountLine.xMm * 1.01))}`)
    expect(html).toContain(`width:${mmCss(roundMm(amountLine.widthMm * 1.01))}`)
    expect(html).not.toContain('transform:scale')
  })

  it('scales the font with the page, so a stretched print stays legible in its box', () => {
    const layout = fixtureLayout()
    const calibration = fixtureCalibration({ offsetXMm: 0, offsetYMm: 0, scaleX: 1.1, scaleY: 1.1 })
    const html = renderPrintDocument({ layout, profile: fixtureProfile(), calibration }).html
    expect(html).toContain('font-size:13.2pt')
  })

  it('leaves the geometry alone when the calibration is missing, and never invents a zero', () => {
    const layout = fixtureLayout()
    const uncalibrated = renderPrintDocument({ layout, profile: fixtureProfile(), calibration: null }).html
    const explicitZero = renderPrintDocument({
      layout,
      profile: fixtureProfile(),
      calibration: fixtureCalibration({ offsetXMm: 0, offsetYMm: 0, scaleX: 1, scaleY: 1 }),
    }).html
    expect(uncalibrated).toBe(explicitZero)
  })

  it('prints a rotated run with a CSS rotation about its left edge', () => {
    const template = fixtureTemplate({
      fields: [
        {
          id: 'stub-note',
          key: 'memo',
          label: 'Stub',
          xMm: 8,
          yMm: 20,
          widthMm: 40,
          heightMm: 8,
          rotationDeg: 90,
          source: 'memo',
        },
      ],
    })
    const layout = buildPrintLayout({ template, data: fixtureData({ memo: 'counterfoil' }) })
    const html = renderPrintDocument({ layout, profile: fixtureProfile() }).html
    expect(html).toContain('transform:rotate(90deg)')
    expect(html).toContain('transform-origin:left center')
  })
})

describe('the printed document is data only', () => {
  function htmlOfFont(family: string): string {
    const template = createBankChequeTemplate({
      id: 'font-check',
      bankId: 'bank:fixture',
      bankName: 'Fixture',
      name: 'Font check',
      stockType: 'personal',
      paper: { widthMm: 210, heightMm: 85, orientation: 'landscape', bodyOriginMm: { xMm: 0, yMm: 0 }, bodyWidthMm: 210, bodyHeightMm: 85 },
      fields: [{ id: 'payee', key: 'payee', label: 'Payee', xMm: 12, yMm: 30, widthMm: 100, heightMm: 8, fontFamily: family, source: 'payeeName' }],
    })
    return renderPrintDocument({
      layout: buildPrintLayout({ template, data: createChequePrintData({ chequeNumber: '1', date: '2026-09-18', payeeName: 'Acme', amountDecimal: '1.00', currency: 'EGP' }) }),
      profile: fixtureProfile(),
    }).html
  }

  it('fails closed on a font family that carries CSS, rather than trying to clean it up', () => {
    // Quoting and stripping cannot make a family name safe *and* faithful, so a name that looks like
    // a declaration is refused: the fix belongs in the template, not in an escaping layer.
    expect(() => htmlOfFont('Times New Roman"; background: url(evil.png)')).toThrow(PrintBlockedError)
    const html = renderPrintDocument({
      layout: buildPrintLayout({
        template: createBankChequeTemplate({
          id: 'font-clean',
          bankId: 'bank:fixture',
          bankName: 'Fixture',
          name: 'Clean font',
          stockType: 'personal',
          paper: { widthMm: 210, heightMm: 85, orientation: 'landscape', bodyOriginMm: { xMm: 0, yMm: 0 }, bodyWidthMm: 210, bodyHeightMm: 85 },
          fields: [{ id: 'payee', key: 'payee', label: 'Payee', xMm: 12, yMm: 30, widthMm: 100, heightMm: 8, fontFamily: 'Times New Roman', source: 'payeeName' }],
        }),
        data: createChequePrintData({ chequeNumber: '1', date: '2026-09-18', payeeName: 'Acme', amountDecimal: '1.00', currency: 'EGP' }),
      }),
      profile: fixtureProfile(),
    }).html
    expect(html).toContain('font-family:"Times New Roman", serif')
  })

  it('falls back to a generic family when the name is unusable', () => {
    const html = htmlOfFont(';;;;')
    expect(html).toContain('font-family:serif')
  })

  it('refuses to emit a document whose structure references the preview artwork', () => {
    // A template whose font is named after the artwork file is a mis-authored template; the guard
    // fails closed rather than printing the bank's background under the customer's data.
    expect(() => htmlOfFont('checkbg')).toThrow(/refusing to emit a print document/)
    try {
      htmlOfFont('checkbg')
    } catch (error) {
      const blocked = error as PrintBlockedError
      expect(blocked.blockers.map((issue) => issue.code)).toContain('PRINT_DOCUMENT_NOT_DATA_ONLY')
      expect(blocked.blockers[0]?.message).toContain('preview-only bank artwork')
    }
  })

  it('does not treat ordinary payee text as markup', () => {
    const template = createBankChequeTemplate({
      id: 'text-check',
      bankId: 'bank:fixture',
      bankName: 'Fixture',
      name: 'Text check',
      stockType: 'personal',
      paper: { widthMm: 210, heightMm: 85, orientation: 'landscape', bodyOriginMm: { xMm: 0, yMm: 0 }, bodyWidthMm: 210, bodyHeightMm: 85 },
      fields: [{ id: 'payee', key: 'payee', label: 'Payee', xMm: 12, yMm: 30, widthMm: 120, heightMm: 8, source: 'payeeName' }],
    })
    const layout = buildPrintLayout({
      template,
      data: createChequePrintData({
        chequeNumber: '1',
        date: '2026-09-18',
        payeeName: 'Watermark & Sons (url: trade)',
        amountDecimal: '1.00',
        currency: 'EGP',
      }),
    })
    const html = renderPrintDocument({ layout, profile: fixtureProfile() }).html
    expect(html).toContain('Watermark &amp; Sons (url: trade)')
    expect(findForbiddenMarkup(html)).toEqual([])
  })

  it('never renders a preview-only guide, whatever it says', () => {
    const layout = fixtureLayout()
    expect(layout.guides.length).toBeGreaterThan(0)
    const html = renderPrintDocument({ layout, profile: fixtureProfile() }).html
    expect(html).not.toContain('MICR band (pre-printed)')
    expect(html).not.toContain('MICR Encode')
    expect(html).not.toContain('001234')
    for (const guide of layout.guides) {
      expect(html).not.toContain(`data-field="${guide.fieldId}"`)
    }
  })

  it('refuses to send an empty page to a printer', () => {
    const empty = buildPrintLayout({
      template: createBankChequeTemplate({
        id: 'blank',
        bankId: 'bank:fixture',
        bankName: 'Fixture',
        name: 'Blank stock',
        stockType: 'personal',
        paper: { widthMm: 210, heightMm: 85, orientation: 'landscape', bodyOriginMm: { xMm: 0, yMm: 0 }, bodyWidthMm: 210, bodyHeightMm: 85 },
        fields: [
          { id: 'payee', key: 'payee', label: 'Payee', xMm: 12, yMm: 30, widthMm: 100, heightMm: 8, source: 'payeeName', isPrinted: false, role: 'guide' },
        ],
      }),
      data: fixtureData(),
      options: { includeGuides: false },
    })
    expect(() => renderPrintDocument({ layout: empty, profile: fixtureProfile() })).toThrow(PrintBlockedError)
    try {
      renderPrintDocument({ layout: empty, profile: fixtureProfile() })
    } catch (error) {
      expect((error as PrintBlockedError).code).toBe('PRINT_BLOCKED')
      expect((error as PrintBlockedError).issues.map((issue) => issue.code)).toContain('EMPTY_PRINT_DOCUMENT')
    }
  })

  it('reports the run it skipped when a line is blank', () => {
    const template = fixtureTemplate()
    const layout = buildPrintLayout({
      template,
      data: fixtureData({ payeeName: 'Acme', memo: null }),
    })
    const html = renderPrintDocument({ layout, profile: fixtureProfile() }).html
    expect(html.match(/<div class="pc-run"/g)).toHaveLength(layout.runs.filter((entry) => entry.text.trim() !== '').length)
    expect(html).toContain('Acme')
  })
})

describe('printedPositionOf — the preview overlay', () => {
  const template: BankChequeTemplate = fixtureTemplate()
  const layout = buildPrintLayout({ template, data: fixtureData() })

  it('shows where this printer will put a field, given its calibration', () => {
    const profile = createPrinterProfile({ id: 'p', name: 'P', xOffsetMm: 3, yOffsetMm: 1, supportsCustomPageSize: true }, FIXED_AT)
    const calibration = createPrinterCalibration(
      { id: 'c', printerProfileId: 'p', templateId: template.id, templateVersion: 1, offsetXMm: -0.5, offsetYMm: 0.5, method: 'manual-ruler', confidence: 'verified' },
      FIXED_AT
    )
    const payee = template.fields.find((field) => field.id === 'payee')!
    expect(printedPositionOf(layout, 'payee', profile, calibration)).toEqual({
      xMm: roundMm(payee.xMm + 2.5),
      yMm: roundMm(payee.yMm + 1.5),
    })
  })

  it('returns null for a field that is not in the layout, rather than inventing a position', () => {
    expect(printedPositionOf(layout, 'no-such-field', fixtureProfile())).toBeNull()
  })

  it('reports the authored position when the device has no offsets', () => {
    const neutral = createPrinterProfile({ id: 'z', name: 'Z', supportsCustomPageSize: true }, FIXED_AT)
    const payee = template.fields.find((field) => field.id === 'payee')!
    expect(printedPositionOf(layout, 'payee', neutral, null)).toEqual({ xMm: payee.xMm, yMm: payee.yMm })
  })
})
