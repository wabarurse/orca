import { listConversations, readConversation } from "../conversations";
import type { Tool } from "./registry";

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

export const subagent: Tool = {
  parallel: input => input.action === "list" || input.action === "siblings",
  spec: { name: "subagent", description: "Delegate and inspect work. spawn: start a bundle (worker by default, or a plugin's bundle) on a branch with a brief: the outcome, acceptance criteria, scope, the user's preferences, prior attempts and evidence, not the full history. In a Git checkout the branch gets its own worktree from the default branch. Spawning the same branch again continues that agent with the new brief (corrections, review feedback), keeping its workspace and context; fresh=true starts its context over. A running agent gets the brief as a message instead. list: subagents with state, last tool and log path. stop: stop one. siblings: the other conversations sharing this bubble or folder. runner: where a spawned agent runs (plain, tmux, rex: the ones on in this bubble), when the user asks; it otherwise follows /mux. show: open a running agent's window for the user (in Rex, beside their orca2 pane; again to put it back). For a review, spawn a worker with a review brief. A worker reports through inbox; a spawn is not a result.",
    input_schema: { type: "object", properties: {
      action: { type: "string", enum: ["spawn", "list", "stop", "show", "siblings"] },
      bundle: { type: "string", description: "spawn: worker (default) or a plugin bundle." },
      branch: { type: "string", description: "spawn: the branch (and agent name), e.g. fix-login." },
      brief: { type: "string" },
      fresh: { type: "boolean" },
      images: { type: "array", maxItems: 4, items: { type: "string" } },
      agent: { type: "string", description: "stop, show: the agent id from list." },
      runner: { type: "string", description: "spawn: plain, tmux or rex; only when the user asks where it should run." },
    }, required: ["action"] } },
  async run(input, ctx) {
    if (input.action === "list") {
      const agents = await ctx.runtime.agents();
      return agents.length === 0 ? "no subagents" : JSON.stringify(agents.map(a => ({ agent: a.agent, bundle: a.bundle, branch: a.branch, state: a.state, lastTool: a.lastTool, startedAt: a.startedAt, endedAt: a.endedAt, log: a.log })));
    }
    if (input.action === "stop") {
      if (typeof input.agent !== "string") throw new Error("stop needs an agent id");
      return ctx.runtime.stop(input.agent);
    }
    if (input.action === "show") {
      if (typeof input.agent !== "string") throw new Error("show needs an agent id");
      return ctx.runtime.show(input.agent);
    }
    if (input.action === "siblings") {
      const self = await readConversation(ctx.conversation);
      const others = (await listConversations()).filter(c => c.id !== ctx.conversation && self !== null && ((self.bubble !== null && c.bubble === self.bubble) || c.directory === self.directory));
      return others.length === 0 ? "no sibling conversations" : others.map(c => `- ${c.id} ${c.name} (${c.directory}${c.bubble === self?.bubble && c.bubble !== null ? ", same bubble" : ""})`).join("\n");
    }
    if (input.action !== "spawn") throw new Error("unknown subagent action");
    if (ctx.role !== "orchestrator") throw new Error("only the orchestrator starts subagents; ask it through inbox");
    const branch = typeof input.branch === "string" ? input.branch.trim() : "";
    if (!BRANCH.test(branch) || branch.includes("..")) throw new Error("branch must be a simple branch name");
    const brief = typeof input.brief === "string" ? input.brief : "";
    if (brief.trim().length === 0) throw new Error("spawn needs a brief");
    const info = await ctx.runtime.spawn({ bundle: typeof input.bundle === "string" && input.bundle.length > 0 ? input.bundle : "worker", branch, brief,
      fresh: input.fresh === true, images: Array.isArray(input.images) ? input.images.filter((id): id is string => typeof id === "string") : [],
      runner: typeof input.runner === "string" && input.runner.length > 0 ? input.runner : null });
    return `${info.agent} ${info.state === "running" ? "got the brief as a message" : "started"} (bundle ${info.bundle}, log ${info.log})`;
  },
};
