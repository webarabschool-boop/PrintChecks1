/**
 * Where a field actually lands on the sheet.
 *
 * The one convention worth stating plainly, because it decides whether a three-cheque voucher strip
 * is a template or a hack: **field coordinates are millimetres within the cheque body, not within
 * the sheet.** The body rectangle (`bodyOriginMm` + `bodyWidthMm`/`bodyHeightMm`) says which part of
 * the physical sheet this template prints onto; the engine adds the offset. `origin` flips the y
 * axis *within the body*, because a bottom-left convention is a statement about how the form was
 * measured, not about where the strip sits.
 *
 * Consequence: the same payee field at (26, 33.5) is correct on a standalone 210×85mm cheque and on
 * the middle cheque of an A4 three-part sheet. That is the difference between one template per stock
 * design (rule T6) and one template per paper size.
 */

import { roundMm, type MmRect } from '../geometry/units'
import type { BankChequeTemplate, TemplateField } from './types'

export function bodyRectOnSheet(template: BankChequeTemplate): MmRect {
  return {
    xMm: template.paper.bodyOriginMm.xMm,
    yMm: template.paper.bodyOriginMm.yMm,
    widthMm: template.paper.bodyWidthMm,
    heightMm: template.paper.bodyHeightMm,
  }
}

/** Field rectangle in sheet coordinates, top-left anchored — what CSS absolute positioning wants. */
export function fieldRectOnSheet(template: BankChequeTemplate, field: TemplateField): MmRect {
  const body = bodyRectOnSheet(template)
  const yWithinBody =
    template.origin === 'top-left'
      ? field.yMm
      : roundMm(body.heightMm - (field.yMm + field.heightMm))
  return {
    xMm: roundMm(body.xMm + field.xMm),
    yMm: roundMm(body.yMm + yWithinBody),
    widthMm: roundMm(field.widthMm),
    heightMm: roundMm(field.heightMm),
  }
}

export function sheetRect(template: BankChequeTemplate): MmRect {
  return { xMm: 0, yMm: 0, widthMm: template.paper.widthMm, heightMm: template.paper.heightMm }
}
