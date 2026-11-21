// pr-watch's TUI parts: a PRs tab with each watched PR's last observation, and a count of blocked PRs.
import { defineUi, type PluginUi } from "../../core/plugins";
import type { Tone } from "../../core/plugins/types";
import { readObservations, type Verdict } from "./watch";

const tones: Record<Verdict, Tone> = { merged: "good", closed: "dim", blocked: "bad", clear: "normal" };
const words: Record<Verdict, string> = { merged: "merged", closed: "closed", blocked: "blocked", clear: "open" };

const ui: PluginUi = defineUi({
  tabs: [{
    id: "prs",
    title: "PRs",
    chord: null,
    rows: async ctx => Object.values(await readObservations(await ctx.data("conversation")))
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
      .map(o => ({ id: `${o.repo}#${o.number}`, name: `${o.repo}#${o.number}`, status: words[o.verdict], info: `task #${o.task}${o.waiting.length > 0 ? ` · waiting on ${o.waiting.join(", ")}` : ""}`, tone: tones[o.verdict] })),
    details: async (row, ctx) => {
      const o = (await readObservations(await ctx.data("conversation")))[row.id];
      if (o === undefined) return [];
      return [
        { title: `PR #${o.number}`, lines: [o.url, `task #${o.task}${o.branch === null ? "" : ` on ${o.branch}`}`, `head ${o.head}`, `observed ${o.observedAt}`] },
        { title: "Blocks the merge", lines: o.blockers.length > 0 ? o.blockers : ["nothing fixable"] },
        { title: "Waiting on", lines: o.waiting.length > 0 ? o.waiting : ["nothing"] },
      ];
    },
    actions: [],
  }],
  counts: [{ id: "blocked-prs", count: async ctx => Object.values(await readObservations(await ctx.data("conversation"))).filter(o => o.verdict === "blocked").length, label: n => `${n} blocked PR${n === 1 ? "" : "s"}` }],
  commands: [],
  toolLines: {},
  folds: {},
});

export default ui;
