import { definePlugin, noHooks, type Plugin } from "../../core/plugins";

const plugin: Plugin = definePlugin({
  name: "tmux",
  description: "Runs agents in tmux windows (orca2's own tmux server, a session per conversation) you can attach to; choose it with /mux.",
  tools: [],
  prompt: [],
  skills: ["skills/tmux"],
  storage: [],
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
