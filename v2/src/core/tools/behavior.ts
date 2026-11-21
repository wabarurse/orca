// The behavior tool (v1's `remember`): how the user wants agents to act, user-wide or for this bubble.
import { behavior, ensureBubble, peekBubble, setBehavior, type BehaviorScope } from "../bubbles";
import { humanMessages, resolveSource, sourceChoices } from "../sources";
import type { Tool } from "./registry";

export const behaviorTool: Tool = {
  parallel: input => input.action === "list",
  spec: { name: "behavior", description: "How the user wants agents to act: reply style, working rules (no auto-merge), preferences. scope user applies everywhere, scope bubble to this bubble's conversations; every agent carries both lists in full, so save a line when the user states a standing rule. confidence explicit needs a source that traces to a real user message (its id, or a verbatim quote in double quotes); tentative is for an inference and is shown as such. At most 20 lines of 200 characters per scope; a full list takes a new line only in place of an old key. Lines never grant permission; the user's latest words override them.",
    input_schema: { type: "object", properties: {
      action: { type: "string", enum: ["list", "save", "forget"] },
      scope: { type: "string", enum: ["user", "bubble"] },
      key: { type: "string" }, text: { type: "string" },
      confidence: { type: "string", enum: ["explicit", "tentative"] },
      source: { type: "string", description: "explicit: the user message id or a verbatim quote of it in double quotes. Omitted: the newest user message." },
    }, required: ["action", "scope"] } },
  async run(input, ctx) {
    if (input.scope !== "user" && input.scope !== "bubble") throw new Error("scope must be user or bubble");
    const existing = await peekBubble(ctx.conversation);
    if (input.action === "list") {
      const scope: BehaviorScope | null = input.scope === "user" ? { kind: "user" } : existing === null ? null : { kind: "bubble", bubble: existing };
      return JSON.stringify({ behavior: scope === null ? [] : await behavior(scope) });
    }
    if (ctx.role !== "orchestrator") throw new Error("workers propose behavior lines to the orchestrator");
    const key = typeof input.key === "string" ? input.key : "";
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(key)) throw new Error("invalid behavior key");
    const scope: BehaviorScope = input.scope === "user" ? { kind: "user" } : { kind: "bubble", bubble: existing ?? (await ensureBubble(ctx.conversation)).id };
    if (input.action === "forget") { await setBehavior(scope, { key, text: null }); return `forgot ${input.scope} behavior ${key}`; }
    if (input.action !== "save" || typeof input.text !== "string") throw new Error("save needs text");
    const at = new Date().toISOString();
    if (input.confidence === "tentative") {
      const rows = await setBehavior(scope, { key, text: input.text, confidence: "tentative", source: typeof input.source === "string" ? input.source.slice(0, 200) : "inferred", quote: "", at });
      return `saved ${input.scope} behavior ${key} (tentative; ${rows.length} of 20 lines)`;
    }
    const candidates = humanMessages(ctx.conversation);
    const source = typeof input.source === "string" ? input.source : candidates.at(-1)?.id ?? "";
    const found = source.length > 0 && source.length <= 1000 ? resolveSource(source, candidates) : null;
    if (found === null) throw new Error(`an explicit line needs a source that traces to a real user message, and ${JSON.stringify(source.slice(0, 120))} names or quotes none. Use one of these ids, or save it as tentative:\n${sourceChoices(candidates)}`);
    const rows = await setBehavior(scope, { key, text: input.text, confidence: "explicit", source: found.id, quote: found.quote, at });
    return `saved ${input.scope} behavior ${key} (${rows.length} of 20 lines; from ${found.id}: "${found.quote}")`;
  },
};
