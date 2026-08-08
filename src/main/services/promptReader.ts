/**
 * Prompt reader — parses `ALL-MASTER-PROMPTS.md` into a structured shot list.
 *
 * Expected file format:
 *
 *   SHOT 001
 *
 *   MASTER PROMPT
 *   ...any number of prompt lines...
 *
 *   NEGATIVE PROMPT
 *   ...any number of negative lines...
 *
 *   SHOT 002
 *   ...
 *
 * Parsing is deliberately tolerant:
 *  - `SHOT`, `MASTER PROMPT`, `NEGATIVE PROMPT` are case-insensitive.
 *  - A header may carry inline content (`NEGATIVE PROMPT: blurry, noise`).
 *  - A shot with no NEGATIVE PROMPT section is valid (negative = "").
 *  - Anything before the first SHOT header is treated as a title/notes block.
 */
import { PROMPTS_FILE } from '../../shared/constants'
import type { Shot } from '../../shared/types'

export interface PromptParseResult {
  shots: Shot[]
  warnings: string[]
}

/** Detect a shot header like `SHOT 001` or `shot 12`. */
const SHOT_HEADER = /^SHOT\s+(\d+)\s*$/i

/** Detect a MASTER PROMPT / NEGATIVE PROMPT header, with optional inline body. */
const SECTION_HEADER = /^\s*(MASTER\s+PROMPT|NEGATIVE\s+PROMPT)\s*:?\s*(.*)$/i

function parseShotBody(body: string): { master: string; negative: string } {
  const master: string[] = []
  const negative: string[] = []
  let mode: 'none' | 'master' | 'negative' = 'none'

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    const header = SECTION_HEADER.exec(line)
    if (header) {
      const section = header[1].toUpperCase()
      mode = section === 'MASTER PROMPT' ? 'master' : 'negative'
      // Allow inline content after the header: "NEGATIVE PROMPT: blurry".
      if (header[2]) {
        ;(mode === 'master' ? master : negative).push(header[2].trim())
      }
      continue
    }

    if (mode === 'master') master.push(line)
    else if (mode === 'negative') negative.push(line)
  }

  return { master: master.join('\n').trim(), negative: negative.join('\n').trim() }
}

export function parsePromptFile(content: string): PromptParseResult {
  const shots: Shot[] = []
  const warnings: string[] = []

  // Split on SHOT headers, keeping the captured number.
  // Result: [preamble, "001", body1, "002", body2, ...]
  const tokens = content.split(/^SHOT\s+(\d+)\s*$/im)
  for (let i = 1; i < tokens.length; i += 2) {
    const number = Number.parseInt(tokens[i], 10)
    const body = (tokens[i + 1] ?? '').trim()

    if (!body) {
      warnings.push(`SHOT ${number}: block is empty, skipping.`)
      continue
    }

    const { master, negative } = parseShotBody(body)
    if (!master) {
      warnings.push(`SHOT ${number}: no MASTER PROMPT section found.`)
    }

    shots.push({
      number,
      masterPrompt: master,
      negativePrompt: negative,
      status: 'waiting',
      imagePath: null,
      retryCount: 0
    })
  }

  shots.sort((a, b) => a.number - b.number)
  return { shots, warnings }
}

export async function readPromptFile(promptsFile: string): Promise<PromptParseResult> {
  const { readFile } = await import('node:fs/promises')
  let content: string
  try {
    content = await readFile(promptsFile, 'utf-8')
  } catch (err) {
    throw new Error(
      `Could not read ${PROMPTS_FILE} (${promptsFile}): ${(err as Error).message}`
    )
  }
  return parsePromptFile(content)
}
