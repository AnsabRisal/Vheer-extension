/**
 * ComfyUI generator — Phase 4 skeleton.
 *
 * ComfyUI runs a local HTTP server with a stable, JSON-based API, which makes
 * it an excellent "always works" generator for people who run ComfyUI locally:
 *
 *   POST /prompt      { prompt: <workflow JSON>, client_id }   → { prompt_id }
 *   GET  /history/{prompt_id}  → poll until the job is done
 *   GET  /view?filename=…     → raw image bytes
 *
 * The workflow JSON can be exported from the ComfyUI web UI and stored per
 * project. `{prompt}` is inserted into the workflow's text-encoder node and
 * `{negative_prompt}` into the negative encoder node.
 *
 * To activate: implement the three methods, then register in the registry.
 */
import type { GeneratorContext, GeneratorPlugin, GenerationResult } from '../../shared/generator'

export const comfyuiGenerator: GeneratorPlugin = {
  id: 'comfyui',
  name: 'ComfyUI (Local)',
  supportsNegativePrompt: true,

  async open(_ctx: GeneratorContext): Promise<void> {
    // No browser needed — verify the server is reachable (e.g. GET /system_stats).
  },

  async generate(_ctx: GeneratorContext): Promise<void> {
    // Queue the workflow with the shot's prompt substituted, then poll /history.
    throw new Error('ComfyUI generator: not implemented yet (Phase 4).')
  },

  async download(_ctx: GeneratorContext): Promise<GenerationResult> {
    // Pull the output image bytes via GET /view.
    throw new Error('ComfyUI generator: not implemented yet (Phase 4).')
  },

  async close(): Promise<void> {
    // Nothing to clean up.
  }
}
