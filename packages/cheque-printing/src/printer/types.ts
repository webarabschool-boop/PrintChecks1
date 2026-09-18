/**
 * Printer profiles and calibration — the device half of the pipeline (§8.4, §8.5).
 *
 * The dividing line is absolute: a **template** describes the *paper* (rule T7), a **profile**
 * describes the *device*, and a **calibration** describes what this device actually did to this
 * stock on the day it was measured. Merging them is the mistake that makes a layout unusable on a
 * second printer, so calibration is a separate record, looked up by `(printerProfileId, templateId)`,
 * and applied as a transform rather than baked into geometry.
 */

export type PaperFeed = 'manual' | 'tray' | 'continuous' | 'sheet'
export type DuplexMode = 'none' | 'long-edge' | 'short-edge'
export type ColourMode = 'mono' | 'colour'

export interface MmMargins {
  readonly topMm: number
  readonly rightMm: number
  readonly bottomMm: number
  readonly leftMm: number
}

export interface PrinterProfile {
  readonly id: string
  readonly name: string
  readonly make?: string | null
  readonly model?: string | null
  readonly driverOrQueue?: string | null
  readonly paperFeed: PaperFeed
  readonly trayId?: string | null
  readonly orientation: 'portrait' | 'landscape'
  readonly duplex: DuplexMode
  /** Device resolution. Used for DPI sanity warnings only — never to rescale mm geometry. */
  readonly nominalDpi: { readonly x: number; readonly y: number }
  /** Nominal device offsets, BEFORE calibration. They are a starting guess, not a measurement. */
  readonly xOffsetMm: number
  readonly yOffsetMm: number
  readonly scale: { readonly x: number; readonly y: number }
  readonly unprintableMarginMm: MmMargins
  readonly supportsCustomPageSize: boolean
  readonly colourMode: ColourMode
  /**
   * Declared capability only. This phase prints no MICR, so the flag informs a warning
   * ("this stock needs MICR toner; the bank or a MICR device must print the band") and nothing
   * else — it never enables an encoder that does not exist.
   */
  readonly micrTonerCapable: boolean
  readonly notes?: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export type CalibrationMethod = 'manual-ruler' | 'test-page' | 'micr-reader'
export type CalibrationConfidence = 'draft' | 'verified'

export interface PrinterCalibration {
  readonly id: string
  readonly printerProfileId: string
  /** Calibration is per (device, stock) pair — a different template is a different measurement. */
  readonly templateId: string
  readonly templateVersion: number
  readonly measuredAt: string
  readonly measuredBy?: string | null
  /** Measured deviation to be compensated, in mm. Positive = content landed too far right/down. */
  readonly offsetXMm: number
  readonly offsetYMm: number
  /** 1.0 = no correction. */
  readonly scaleX: number
  readonly scaleY: number
  readonly skewDeg?: number
  readonly method: CalibrationMethod
  readonly confidence: CalibrationConfidence
  /** The test page this came from, so a correction can be re-measured on the same artefact. */
  readonly sourceTestPageHash?: string | null
  readonly notes?: string | null
  /** Deviation beyond this is not a calibration, it is a fault (paper size, driver scaling). */
  readonly maxAllowedOffsetMm?: number
  readonly maxAllowedScaleError?: number
}

export interface CalibrationLimits {
  readonly maxAllowedOffsetMm: number
  readonly maxAllowedScaleError: number
  readonly maxAllowedSkewDeg: number
}

export const DEFAULT_CALIBRATION_LIMITS: CalibrationLimits = {
  maxAllowedOffsetMm: 4,
  maxAllowedScaleError: 0.02,
  maxAllowedSkewDeg: 0.5,
}

export const DEFAULT_UNPRINTABLE_MARGIN_MM: MmMargins = {
  topMm: 4.2,
  rightMm: 4.2,
  bottomMm: 4.2,
  leftMm: 4.2,
}

export interface CreateProfileInput {
  readonly id: string
  readonly name: string
  readonly make?: string | null
  readonly model?: string | null
  readonly driverOrQueue?: string | null
  readonly paperFeed?: PaperFeed
  readonly trayId?: string | null
  readonly orientation?: 'portrait' | 'landscape'
  readonly duplex?: DuplexMode
  readonly nominalDpi?: { readonly x: number; readonly y: number }
  readonly xOffsetMm?: number
  readonly yOffsetMm?: number
  readonly scale?: { readonly x: number; readonly y: number }
  readonly unprintableMarginMm?: Partial<MmMargins>
  readonly supportsCustomPageSize?: boolean
  readonly colourMode?: ColourMode
  readonly micrTonerCapable?: boolean
  readonly notes?: string | null
  readonly createdAt?: string
  readonly updatedAt?: string
}
