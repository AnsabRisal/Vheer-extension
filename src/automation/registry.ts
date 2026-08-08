/**
 * Generator registry — the single place a generator is wired into the app.
 *
 * To add a generator:
 *   1. Implement `GeneratorPlugin` in `src/automation/generators/<name>.ts`
 *      (the FLUX and ComfyUI files already contain a typed skeleton).
 *   2. Import it here and add it to the `registry` map.
 *   3. It immediately appears in Settings → Generator.
 *
 * The core app never imports a concrete generator directly.
 */
import type { GeneratorPlugin } from '../shared/generator'
import { vheerGenerator } from './generators/vheer'

const registry: Record<string, GeneratorPlugin> = {
  [vheerGenerator.id]: vheerGenerator
  // Phase 4:
  // [fluxGenerator.id]: fluxGenerator
  // [comfyuiGenerator.id]: comfyuiGenerator
}

export function getGenerator(id: string): GeneratorPlugin {
  const plugin = registry[id]
  if (!plugin) throw new Error(`Unknown generator: "${id}"`)
  return plugin
}

export function listGenerators(): { id: string; name: string }[] {
  return Object.values(registry).map((g) => ({ id: g.id, name: g.name }))
}

export function generatorExists(id: string): boolean {
  return id in registry
}
