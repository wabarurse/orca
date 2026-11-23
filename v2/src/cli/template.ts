export function pluginTemplate(name: string): Record<string, string> {
  const tool = name.replaceAll("-", "_");
  return {
    "index.ts": `import type { Plugin } from "orca2/plugin";

const plugin: Plugin = {
  name: "${name}",
  description: "What ${name} adds, in one line.",
  tools: [{
    roles: ["orchestrator", "worker"],
    replaces: false,
    tool: {
      parallel: () => true,
      spec: { name: "${tool}", description: "What the tool does and when to use it.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
      async run(input, ctx) {
        const dir = await ctx.runtime.agents();
        return \`${tool}: \${String(input.text)} (\${dir.length} subagents in \${ctx.conversation})\`;
      },
    },
  }],
  prompt: [],
  skills: [],
  storage: [],
  hooks: { beforeTool: [], afterTool: [], beforeRequest: [], onInput: [] },
  guard: [],
  retention: [],
  provides: [],
  uses: [],
  emits: [],
  on: [],
  bundles: [],
  ui: null,
  background: null,
};

export default plugin;
`,
    [`${name}.test.ts`]: `import { expect, test } from "bun:test";
import plugin from "./index";

test("${name} loads with its tool", () => {
  expect(plugin.name).toBe("${name}");
  expect(plugin.tools.map(t => t.tool.spec.name)).toEqual(["${tool}"]);
});
`,
    "README.md": `# ${name}\n\nWhat it adds and why. See the orca-plugin skill for every slot.\n`,
  };
}
