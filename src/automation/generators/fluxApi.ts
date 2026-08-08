/**
 * FLUX API generator — Phase 4 skeleton.
 *
 * This is the template for any hosted image API (fal.ai / Replicate / BFL).
 * An API generator is the most reliable kind to automate: no DOM to scrape,
 * no CAPTCHAs. It still implements `GeneratorPlugin`, so the engine treats it
 * exactly like a browser generator — `browser`/`page` in the context are
 * simply unused.
 *
 * To activate:
 *   1. Store your API key in settings (add an `apiKey` field to `Settings`).
 *   2. Fill in the real endpoint, request body and polling loop below.
 *   3. Register it in `src/automation/registry.ts`.
 *
 * Example flow for a hosted FLUX endpoint:
 *   POST /v1/images/generations
 *     { model: "black-forest-labs/flux-1.1-pro", prompt, negative_prompt }
 *   → returns { id }
 *   GET  /v1/images/generations/{id}  → poll until status === "succeeded"
 *   → returns { image_url }  → fetch bytes → return as buffer
 */
import type { GeneratorContext, GeneratorPlugin, GenerationResult } from '../../shared/generator'

export const fluxGenerator: GeneratorPlugin = {
  id: 'flux',
  name: 'FLUX (API)',
  supportsNegativePrompt: true,

  async open(): Promise<void> {
    // API generators need no browser interaction.
  },

  async generate(_ctx: GeneratorContext): Promise<void> {
    // 1. Build the request body from ctx.shot + ctx.settings.
    // 2. POST to the endpoint; read the job id.
    // 3. Poll until the image is ready.
    throw new Error('FLUX generator: not implemented yet (Phase 4).')
  },

  async download(_ctx: GeneratorContext): Promise<GenerationResult> {
    // Fetch the finished image bytes from the result URL.
    throw new Error('FLUX generator: not implemented yet (Phase 4).')
  },

  async close(): Promise<void> {
    // No browser to clean up.
  }
}
