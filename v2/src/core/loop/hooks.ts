import type { Tool as ApiTool, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { AfterTool, BeforeRequest, BeforeTool, OnInput, PluginContext } from "../plugins/types";
import type { ToolResult } from "../tools/registry";
import type { Message } from "../types";

export type Bound<H> = { hook: H; ctx: PluginContext };
export type LoopHooks = { beforeTool: Bound<BeforeTool>[]; afterTool: Bound<AfterTool>[]; beforeRequest: Bound<BeforeRequest>[]; onInput: Bound<OnInput>[] };

export const emptyHooks = (): LoopHooks => ({ beforeTool: [], afterTool: [], beforeRequest: [], onInput: [] });

const named = (ctx: PluginContext, error: unknown): Error => new Error(`plugin ${ctx.plugin}: ${error instanceof Error ? error.message : String(error)}`);

export type ToolDecision = { action: "run"; input: Record<string, unknown> } | { action: "block"; reason: string };

export async function beforeTool(hooks: LoopHooks, name: string, input: Record<string, unknown>, confirm: (question: string) => Promise<boolean>): Promise<ToolDecision> {
  let current = input;
  for (const { hook, ctx } of hooks.beforeTool) {
    let result;
    try { result = await hook({ name, input: current }, ctx); }
    catch (error) { return { action: "block", reason: named(ctx, error).message }; }
    if (result.action === "block") return { action: "block", reason: `blocked by plugin ${ctx.plugin}: ${result.reason}` };
    if (result.action === "ask") {
      if (!await confirm(`${ctx.plugin}: ${result.question}`)) return { action: "block", reason: `the user declined (plugin ${ctx.plugin} asked: ${result.question})` };
      continue;
    }
    current = result.input;
  }
  return { action: "run", input: current };
}

export async function afterTool(hooks: LoopHooks, name: string, input: Record<string, unknown>, result: { ok: boolean; content: ToolResult }): Promise<{ ok: boolean; content: ToolResult }> {
  let current = result;
  for (const { hook, ctx } of hooks.afterTool) {
    try { current = await hook({ name, input }, current, ctx); }
    catch (error) { return { ok: false, content: named(ctx, error).message }; }
  }
  return current;
}

export async function beforeRequest(hooks: LoopHooks, request: { system: string; messages: MessageParam[]; tools: ApiTool[] }): Promise<{ system: string; messages: MessageParam[]; tools: ApiTool[] }> {
  let current = request;
  for (const { hook, ctx } of hooks.beforeRequest) {
    try { current = await hook(current, ctx); }
    catch (error) { throw named(ctx, error); }
  }
  return current;
}

export async function onInput(hooks: LoopHooks, message: Message): Promise<{ message: Message; dropped: string | null }> {
  if (message.from !== "user") return { message, dropped: null };
  let current = message;
  for (const { hook, ctx } of hooks.onInput) {
    let result;
    try { result = await hook(current, ctx); }
    catch (error) { return { message: current, dropped: named(ctx, error).message }; }
    if (result.action === "drop") return { message: current, dropped: `${ctx.plugin}: ${result.reason}` };
    current = { ...current, text: result.text };
  }
  return { message: current, dropped: null };
}
