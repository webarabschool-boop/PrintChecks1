/**
 * Hashing for pinning and verification.
 *
 * 64-bit FNV-1a, implemented with `Math.imul` so the arithmetic is identical in Node, in a
 * browser and in a worker — no `crypto`, no `Buffer`, no `TextEncoder` dependency. This is NOT a
 * security primitive; it is a change detector that lets a print job pin the exact template and
 * layout it used (rule A4: reproducibility) and lets the audit chain prove that a record was
 * altered afterwards.
 */

import { canonicalJson } from './canonicalJson'

const FNV_OFFSET_BASIS_32 = 0x811c9dc5
const FNV_PRIME_32 = 0x01000193

function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME_32) >>> 0
  }
  return hash >>> 0
}

/** 16 hex characters: two independent 32-bit FNV passes over different seed/input mixes. */
export function hashString(input: string): string {
  const high = fnv1a32(input, FNV_OFFSET_BASIS_32)
  const low = fnv1a32(`${input}\u0001${String(input.length)}`, FNV_OFFSET_BASIS_32 ^ 0x9e3779b9)
  return `${hex32(high)}${hex32(low)}`
}

export function hashCanonical(value: unknown): string {
  return hashString(canonicalJson(value))
}

/** Short, human-facing form for UIs and log lines. */
export function shortHash(value: unknown): string {
  return hashCanonical(value).slice(0, 8)
}

export function isHashString(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value)
}

function hex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0')
}
