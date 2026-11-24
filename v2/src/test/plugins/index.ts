import { join } from "node:path";
import { defineBackground, definePlugin, noHooks, type BuiltinPlugin, type Runner } from "../../core/plugins";

export const EXAMPLE: BuiltinPlugin = {
  name: "example", dir: join(import.meta.dir, "example"),
  index: () => import("./example/index"), ui: () => import("./example/ui"), background: () => import("./example/background"),
};

export function runnerPlugin(name: string): BuiltinPlugin {
  const runner: Runner = { name, start: async () => ({ handle: name, pid: null }), alive: async () => [], stop: async () => undefined, attach: async () => ({ ok: false, error: "fake" }) };
  return {
    name, dir: join(import.meta.dir, name), ui: null,
    index: async () => ({ default: definePlugin({ name, description: name, tools: [], prompt: [], skills: [], storage: [], hooks: noHooks(), bundles: [], guard: [], retention: [],
      provides: [], uses: [], emits: [], on: [], ui: null, background: "./background.ts" }) }),
    background: async () => ({ default: defineBackground({ watchers: [], memory: null, runner, stop: null, remove: null }) }),
  };
}
