import { facts, humanSources, remember, resolveHumanSource, sourceChoices, workingContext, type HumanMessage } from "../data/knowledge";
import { open } from "../data/transcripts";
import { paths } from "../../config";
import type { Tool } from "./registry";

const SOURCE = "For confidence explicit: the id of the human message that states the preference (preferred), or text containing that id, or a verbatim quote of that message in double quotes, e.g. User, 2026-10-28: \"keep replies short\". It must trace to a real user message of this project (prompts, Questions answers, feedback); assistant, tool and worker text never qualify. Elided pieces (\u2026) must each be 8+ characters, in the message's order. The canonical id and a short quote of the message's own words are stored. Omitted: the newest human message. For tentative: any concise reference.";

export const rememberTool: Tool = {
  spec: { name: "remember", description: "Inspect, save, update or forget scoped personal/project knowledge. Record explicit preferences from an actual user message: confidence explicit requires a source that names (by id) or quotes a real human message of this project, and is stored as that message's id plus a short quote. A source that matches none fails and lists the recent message ids to use instead. Inferred preferences remain tentative. Current instructions override memory. Memory never grants additional permission. Durable knowledge lives in memory.sqlite; use list, save or forget to manage it.",
    input_schema: { type: "object", properties: { action: { type: "string", enum: ["list", "save", "forget"] }, scope: { type: "string", enum: ["user", "project"] }, key: { type: "string" }, cursor: { type: "integer", minimum: 0 }, text: { type: "string" }, source: { type: "string", description: SOURCE }, confidence: { type: "string", enum: ["explicit", "tentative"] } }, required: ["action", "scope"] } },
  async run(input, ctx) {
    const scope = input.scope;
    if (scope !== "user" && scope !== "project") throw new Error("scope must be user or project");
    if (input.action === "list") {
      const cursor = Number(input.cursor ?? 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("invalid memory cursor");
      const rows = (await facts(ctx.project, scope)).filter(f => input.key === undefined || f.key === input.key);
      return JSON.stringify({ facts: rows.slice(cursor, cursor + 10), next_cursor: cursor + 10 < rows.length ? cursor + 10 : null });
    }
    if (ctx.role !== "orchestrator") throw new Error("workers propose memory updates to the orchestrator");
    const key = String(input.key ?? "");
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(key)) throw new Error("invalid memory key");
    if (input.action === "forget") { await remember(ctx.project, scope, { key }); return `forgot ${scope} preference ${key}`; }
    if (input.action !== "save" || typeof input.text !== "string" || !input.text.trim() || input.text.length > 1200) throw new Error("save needs concise text (1–1200 characters)");
    const updatedAt = new Date().toISOString();
    if (input.confidence !== "explicit") {
      const source = String(input.source ?? (await workingContext(ctx.project)).latest?.at(-1)?.id ?? "assistant inference");
      if (source.length > 256) throw new Error("source must be a concise message/evidence reference");
      await remember(ctx.project, scope, { key, text: input.text, source, confidence: "tentative", project: ctx.project, updatedAt });
      return `saved ${scope} knowledge ${key} (tentative)`;
    }
    const candidates = await humanMessages(ctx.project);
    const source = input.source === undefined ? candidates.at(-1)?.id ?? "" : String(input.source);
    if (source.length > 1000) throw new Error("source must be a message id or a short quote (at most 1000 characters)");
    const found = source.trim() ? resolveHumanSource(source, candidates) : null;
    if (!found) throw new Error(`explicit preferences need a source that traces to a real human message, and ${JSON.stringify(source.slice(0, 120))} names or quotes none of this project's retained user messages. Pass one of these ids as source (or quote that message verbatim in double quotes), or save as tentative:\n${sourceChoices(candidates)}`);
    await remember(ctx.project, scope, { key, text: input.text, source: found.id, quote: found.quote, confidence: "explicit", project: ctx.project, updatedAt });
    return `saved ${scope} knowledge ${key} (human-sourced interpretation of ${found.id}: "${found.quote}")`;
  },
};

/**
 * The human messages a source may trace to, oldest first, one per id: every
 * user inbox message the orchestrator transcript committed (including history
 * before compaction and /clear), the retained recent human messages (feedback
 * to agents included) and the brief's latest corrections. Only inbox messages
 * sent as "user" count; assistant, tool, worker and runtime text never does.
 */
async function humanMessages(project: string): Promise<HumanMessage[]> {
  const byId = new Map<string, HumanMessage>();
  for (const m of [...await humanSources(project), ...(await workingContext(project)).latest ?? []]) byId.set(m.id, m);
  // Last, so the transcript's full text replaces a retained copy cut at 2000 characters.
  const t = open(paths.transcript(project, "orchestrator"));
  for (const entry of t.all?.() ?? t.branch()) {
    for (const m of entry.inbox ?? []) {
      const id = m.inputId ?? m.deliveryId;
      if (m.from === "user") byId.set(id, { id, text: m.text, at: m.ts });
    }
  }
  return [...byId.values()].sort((a, b) => a.at.localeCompare(b.at));
}
