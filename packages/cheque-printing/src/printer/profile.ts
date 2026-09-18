import { roundMm } from '../geometry/units'
import type { PrintingIssue } from '../errors'
import {
  DEFAULT_UNPRINTABLE_MARGIN_MM,
  type MmMargins,
  type PrinterProfile,
  type CreateProfileInput,
} from './types'

export function createPrinterProfile(input: CreateProfileInput, at: string): PrinterProfile {
  const margin: MmMargins = {
    ...DEFAULT_UNPRINTABLE_MARGIN_MM,
    ...(input.unprintableMarginMm ?? {}),
  }
  const profile: PrinterProfile = {
    id: input.id,
    name: input.name,
    make: input.make ?? null,
    model: input.model ?? null,
    driverOrQueue: input.driverOrQueue ?? null,
    paperFeed: input.paperFeed ?? 'manual',
    trayId: input.trayId ?? null,
    orientation: input.orientation ?? 'landscape',
    duplex: input.duplex ?? 'none',
    nominalDpi: input.nominalDpi ?? { x: 600, y: 600 },
    xOffsetMm: roundMm(input.xOffsetMm ?? 0),
    yOffsetMm: roundMm(input.yOffsetMm ?? 0),
    scale: { x: input.scale?.x ?? 1, y: input.scale?.y ?? 1 },
    unprintableMarginMm: {
      topMm: roundMm(margin.topMm),
      rightMm: roundMm(margin.rightMm),
      bottomMm: roundMm(margin.bottomMm),
      leftMm: roundMm(margin.leftMm),
    },
    supportsCustomPageSize: input.supportsCustomPageSize ?? false,
    colourMode: input.colourMode ?? 'mono',
    micrTonerCapable: input.micrTonerCapable ?? false,
    notes: input.notes ?? null,
    createdAt: input.createdAt ?? at,
    updatedAt: input.updatedAt ?? at,
  }
  return Object.freeze(profile)
}

export function validatePrinterProfile(profile: PrinterProfile): PrintingIssue[] {
  const issues: PrintingIssue[] = []
  const error = (code: string, message: string, remediation: string) =>
    issues.push({ code, severity: 'error', message, remediation })
  const warn = (code: string, message: string, remediation: string) =>
    issues.push({ code, severity: 'warning', message, remediation })

  if (profile.name.trim() === '') {
    error('PROFILE_NAME_REQUIRED', 'a printer profile needs a name — calibration is stored against it', 'name the device')
  }
  for (const [label, dpi] of [['x', profile.nominalDpi.x], ['y', profile.nominalDpi.y]] as const) {
    if (!Number.isFinite(dpi) || dpi < 150 || dpi > 4800) {
      warn(
        'PROFILE_DPI_SUSPECT',
        `nominal DPI (${label}) of ${String(dpi)} is outside 150–4800; it is only used for sanity checks, never to rescale mm geometry`,
        'correct it so the DPI warning is meaningful'
      )
    }
  }
  for (const [label, value] of [
    ['xOffsetMm', profile.xOffsetMm],
    ['yOffsetMm', profile.yOffsetMm],
  ] as const) {
    if (!Number.isFinite(value) || Math.abs(value) > 25) {
      error(
        'PROFILE_OFFSET_UNREALISTIC',
        `${label} = ${String(value)}mm is too large to be a device offset`,
        'a profile offset is a starting guess; measured corrections belong in calibration'
      )
    }
  }
  for (const [label, value] of [
    ['scale.x', profile.scale.x],
    ['scale.y', profile.scale.y],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0.5 || value >= 2) {
      error(
        'PROFILE_SCALE_UNREALISTIC',
        `${label} = ${String(value)} is not a usable nominal scale (0.5–2.0)`,
        'set 1.0 and let calibration carry the measured correction'
      )
    }
    if (Math.abs(value - 1) > 0.02) {
      warn(
        'PROFILE_SCALE_BIAS',
        `${label} is ${String(value)} — a nominal scale away from 1.0 usually means the driver is rescaling the page`,
        'turn off "fit to page" in the driver and calibrate instead'
      )
    }
  }
  for (const [label, value] of [
    ['top', profile.unprintableMarginMm.topMm],
    ['right', profile.unprintableMarginMm.rightMm],
    ['bottom', profile.unprintableMarginMm.bottomMm],
    ['left', profile.unprintableMarginMm.leftMm],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      error(
        'PROFILE_MARGIN_INVALID',
        `unprintable margin ${label} = ${String(value)}mm is invalid`,
        'enter the driver-documented non-printable margin (0 is legal but rare)'
      )
    }
  }
  if (profile.paperFeed === 'manual' && profile.trayId !== null && profile.trayId !== undefined && profile.trayId !== '') {
    warn(
      'PROFILE_TRAY_ON_MANUAL_FEED',
      'a manual-feed device has no tray id; it will be ignored',
      'clear trayId or switch paperFeed to "tray"'
    )
  }
  if (!profile.supportsCustomPageSize) {
    warn(
      'PROFILE_NO_CUSTOM_PAGE_SIZE',
      'the profile does not declare custom page size support, so the print document falls back to the nearest driver page and relies on calibration',
      'confirm the driver accepts a 210x85mm (or template-sized) form, or accept the offset'
    )
  }
  return issues
}
