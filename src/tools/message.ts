import type { Tool } from "./index";

// TODO(PR5): write a file into the project inbox. Workers and reviewers use it
// to report to the orchestrator; the orchestrator uses it to reply to whoever
// is connected (terminal now, Instinct over HTTP in M3).
export const message: Tool = {
  spec: {
    name: "message",
    description: "Send a message to the orchestrator (or, as orchestrator, to the user).",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  async run() {
    throw new Error("message: not implemented");
  },
};
