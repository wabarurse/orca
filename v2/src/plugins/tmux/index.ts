import { definePlugin, noHooks, type Plugin } from "../../core/plugins";

const plugin: Plugin = definePlugin({
  name: "tmux",
  description: "Runs agents in tmux windows (orca2's own tmux server, a session per conversation) you can attach to; /mux picks the runner.",
  tools: [],
  prompt: [],
  skills: ["skills/tmux"],
  storage: [],
  hooks: noHooks(),
  bundles: [],
  ui: "./ui.ts",
  background: "./background.ts",
});

export default plugin;
