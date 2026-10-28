import { facts, remember, workingContext } from "../data/knowledge";
import type { Tool } from "./registry";

export const rememberTool: Tool = {
  spec: { name: "remember", description: "Inspect, save, update or forget scoped personal/project knowledge. Record explicit preferences from an actual user source; inferred preferences remain tentative. Current instructions override memory. Memory never grants additional permission. Durable knowledge lives in memory.sqlite; use list, save or forget to manage it.",
    input_schema: { type: "object", properties: { action: { type: "string", enum: ["list", "save", "forget"] }, scope: { type: "string", enum: ["user", "project"] }, key: { type: "string" }, cursor: { type: "integer", minimum: 0 }, text: { type: "string" }, source: { type: "string" }, confidence: { type: "string", enum: ["explicit", "tentative"] } }, required: ["action", "scope"] } },
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
    const latest = (await workingContext(ctx.project)).latest ?? [];
    const source = String(input.source ?? latest.at(-1)?.id ?? "assistant inference");
    if (source.length > 256) throw new Error("source must be a concise message/evidence reference");
    const explicit = input.confidence === "explicit";
    if (explicit && !latest.some(m => m.id === source)) throw new Error("explicit preferences require a retained human source message; otherwise save as tentative");
    await remember(ctx.project, scope, { key, text: input.text, source, confidence: explicit ? "explicit" : "tentative", project: ctx.project, updatedAt: new Date().toISOString() });
    return `saved ${scope} knowledge ${key} (${explicit ? "human-sourced interpretation" : "tentative"})`;
  },
};
