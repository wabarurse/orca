import type { Tool } from "./index";

// TODO(PR3): run the command in ctx.cwd, cap output at config.maxToolResultBytes
// by truncating the middle (errors are usually at the end), and refuse commands
// that mention sudo. The text check is a nudge; the sandbox user is the real guard.
export const bash: Tool = {
  spec: {
    name: "bash",
    description: "Run a shell command in the working directory. Output is byte-capped. No sudo.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  async run() {
    throw new Error("bash: not implemented");
  },
};
