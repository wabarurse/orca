// The rex plugin: a runner that starts agents as windows of a Rex session per conversation, so a person can watch
// them in Rex beside their own sessions; /mux picks the runner. Selected with `runner = "rex"` in config.toml.
import { definePlugin, noHooks, type Plugin } from "../../core/plugins";

const plugin: Plugin = definePlugin({
  name: "rex",
  description: "Runs agents as windows of a Rex session per conversation (never starts a Rex server); /mux picks the runner.",
  tools: [],
  prompt: [],
  skills: ["skills/rex"],
  storage: [{ scope: "global", about: "rex/used: written when orca2 first opens a Rex session, so Rex is asked only after that" }],
  hooks: noHooks(),
  bundles: [],
  ui: "./ui.ts",
  background: "./background.ts",
});

export default plugin;
