import type { Tool } from "./index";

// TODO(PR5): orchestrator-only. Adds a task to tasks.json, creates a worktree,
// and starts a worker in a tmux window via runner.start(). The worker hands off
// to a reviewer when done; the reviewer reports back through the inbox.
export const spawn: Tool = {
  spec: {
    name: "spawn",
    description: "Start a worker-reviewer loop for a task. Returns the task id.",
    input_schema: {
      type: "object",
      properties: {
        desc: { type: "string", description: "What to build, with acceptance criteria." },
      },
      required: ["desc"],
    },
  },
  async run() {
    throw new Error("spawn: not implemented");
  },
};
