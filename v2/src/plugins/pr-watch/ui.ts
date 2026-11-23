import type { Result } from "../../config";
import { defineUi, type PluginContext, type PluginUi, type Tone } from "../../core/plugins";
import { settled } from "../../core/tools/registry";
import { readObservations, type Observation, type Verdict } from "./watch";

const tones: Record<Verdict, Tone> = { merged: "good", closed: "dim", blocked: "bad", clear: "normal" };
const words: Record<Verdict, string> = { merged: "merged", closed: "closed", blocked: "blocked", clear: "open" };

async function observations(ctx: PluginContext): Promise<Result<Record<string, Observation>>> {
  const dir = await ctx.data("conversation");
  return dir.ok ? readObservations(dir.data) : dir;
}

const ui: PluginUi = defineUi({
  tabs: [{
    id: "prs",
    title: "PRs",
    chord: null,
    rows: async ctx => Object.values(settled(await observations(ctx)))
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
      .map(o => ({ id: `${o.repo}#${o.number}`, name: `${o.repo}#${o.number}`, status: words[o.verdict], info: `task #${o.task}${o.waiting.length > 0 ? ` · waiting on ${o.waiting.join(", ")}` : ""}`, tone: tones[o.verdict] })),
    details: async (row, ctx) => {
      const o = settled(await observations(ctx))[row.id];
      if (o === undefined) return [];
      return [
        { title: `PR #${o.number}`, lines: [o.url, `task #${o.task}${o.branch === null ? "" : ` on ${o.branch}`}`, `head ${o.head}`, `observed ${o.observedAt}`] },
        { title: "Blocks the merge", lines: o.blockers.length > 0 ? o.blockers : ["nothing fixable"] },
        { title: "Waiting on", lines: o.waiting.length > 0 ? o.waiting : ["nothing"] },
      ];
    },
    actions: [],
  }],
  counts: [{ id: "blocked-prs", count: async ctx => {
    const seen = await observations(ctx);
    return seen.ok ? Object.values(seen.data).filter(o => o.verdict === "blocked").length : null;
  }, label: n => `${n} blocked PR${n === 1 ? "" : "s"}` }],
  commands: [],
  toolLines: {},
  folds: {},
});

export default ui;
