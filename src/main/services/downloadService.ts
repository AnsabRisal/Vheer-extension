/**
 * Download manager.
 *
 * Responsibilities:
 *  - Validate a byte blob really is an image (magic-byte sniffing).
 *  - Save it to the project's `Images/` folder under the user's filename
 *    format (e.g. `SHOT001.png`), zero-padded to the shot count.
 *  - NEVER overwrite an existing file — collisions get a `_1`, `_2`, …
 *    suffix (e.g. `SHOT001_1.png`). Regenerating a shot therefore keeps
 *    every prior result on disk.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatFilename, defaultImageExt } from '../../shared/constants'
import type { ImageFormat } from '../../shared/types'
import { downloadLog } from './logService'

/** Sniff the real image format from leading bytes. */
export function detectImageFormat(buffer: Uint8Array): ImageFormat | null {
  const b = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) {
    return 'png'
  }
  // JPEG: FF D8 FF
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return 'jpeg'
  }
  // WebP: "RIFF" ... "WEBP"
  if (
    b.length >= 12 &&
    b.toString('latin1', 0, 4) === 'RIFF' &&
    b.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'webp'
  }
  return null
}

/** Return the first destination path in `dir` that does not exist yet. */
export function uniqueDestination(dir: string, baseName: string, ext: string): string {
  let candidate = join(dir, `${baseName}.${ext}`)
  let i = 1
  while (existsSync(candidate)) {
    candidate = join(dir, `${baseName}_${i}.${ext}`)
    i += 1
  }
  return candidate
}

export interface SaveImageOptions {
  /** Fallback extension used when the format cannot be sniffed. */
  fallbackFormat?: ImageFormat
}

/**
 * Validate, name and persist an image blob inside a project's Images folder.
 * Returns the absolute path that was written.
 */
export function saveImage(
  projectImagesDir: string,
  shotNumber: number,
  totalShots: number,
  buffer: Uint8Array,
  filenameFormat: string,
  opts: SaveImageOptions = {}
): string {
  const detected = detectImageFormat(buffer)
  if (!detected) {
    throw new Error(
      `SHOT ${shotNumber}: downloaded bytes are not a recognized image (png/jpeg/webp).`
    )
  }

  const ext = detected === 'jpeg' ? 'jpg' : detected
  const baseName = formatFilename(shotNumber, totalShots, filenameFormat, ext)
  const dest = uniqueDestination(projectImagesDir, baseName.replace(/\.\w+$/, ''), ext)

  mkdirSync(projectImagesDir, { recursive: true })
  writeFileSync(dest, Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength))
  downloadLog.info(`SHOT ${shotNumber} → ${dest}`)
  return dest
}

/** A filename template may request a specific extension; expose the default. */
export { defaultImageExt }
