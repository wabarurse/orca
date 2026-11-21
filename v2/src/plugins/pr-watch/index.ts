// pr-watch: watches the PRs the tasks plugin links and tells the orchestrator when one merges, closes, is blocked
// by something an agent can fix, or stops being blocked. Read-only on GitHub and on the tasks file; it starts nothing.
import { definePlugin, type Plugin } from "../../core/plugins";

const plugin: Plugin = definePlugin({
  name: "pr-watch",
  description: "PR watch: notices when a task's linked PR merges, closes or is blocked by conflicts, failing checks or requested changes.",
  tools: [],
  prompt: [{ role: "orchestrator", text: "On [pr-blocked], spawn that task's worker on its branch with the blockers; on [pr-merged] or [pr-closed], update the task's status." }],
  skills: [],
  storage: [{ scope: "conversation", about: "pr-watch/prs.json: the latest observation of each watched PR" }],
  hooks: { beforeTool: [], afterTool: [], beforeRequest: [], onInput: [] },
  bundles: [],
  ui: "./ui.ts",
  background: "./background.ts",
});

export default plugin;
