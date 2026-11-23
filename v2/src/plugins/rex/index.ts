import { definePlugin, noHooks, type Plugin } from "../../core/plugins";

const plugin: Plugin = definePlugin({
  name: "rex",
  description: "Runs agents as windows of a Rex session per conversation (never starts a Rex server); choose it with /mux.",
  tools: [],
  prompt: [],
  skills: ["skills/rex"],
  storage: [{ scope: "global", about: "rex/used: written when orca2 first opens a Rex session, so Rex is asked only after that" }],
  hooks: noHooks(),
  bundles: [],
  retention: [],
  guard: [],
  provides: [],
  uses: [],
  emits: [],
  on: [],
  ui: null,
  background: "./background.ts",
});

export default plugin;
