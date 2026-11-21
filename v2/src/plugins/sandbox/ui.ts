// The sandbox plugin's TUI part: how a sandbox call shows in the conversation.
import { defineUi, type PluginUi } from "../../core/plugins";

const ui: PluginUi = defineUi({
  tabs: [],
  counts: [],
  commands: [],
  toolLines: {
    sandbox: {
      label: input => `Sandbox(${typeof input.command === "string" ? input.command.split("\n")[0]!.slice(0, 60) : `clean ${String(input.id)}`})`,
      summary: outcome => {
        const end = /\[sandbox \w+: ([^;]+);/.exec(outcome.text)?.[1] ?? outcome.text.split("\n")[0] ?? "";
        return { summary: end, failed: !outcome.ok || outcome.text.startsWith("refused") || (end.startsWith("exit") && end !== "exit 0") || end.startsWith("timed out") };
      },
    },
  },
  folds: {},
});

export default ui;
