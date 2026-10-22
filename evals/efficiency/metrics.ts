/** Preserve provider token semantics: cached input still occupies context. */
export function jsonLines(text: string): any[] {
  return text.split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}
export function claudeMetrics(events: any[]) {
  const result = events.findLast(e => e.type === "result");
  const usage = result?.usage;
  const messages = new Map<string, any>();
  const tools = new Map<string, any>();
  for (const e of events) if (e.type === "assistant" && e.message?.id) {
    messages.set(e.message.id, e.message);
    for (const block of e.message.content ?? []) if (block.type === "tool_use") tools.set(block.id ?? `${e.message.id}:${block.name}`, block);
  }
  const input = (u: any) => u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const toolCalls = [...tools.values()];
  return {
    answer: result?.result ?? "", error: !result ? "No terminal result" : result.is_error ? result.result || result.subtype : undefined,
    inputTokens: usage ? input(usage) : null,
    cachedInputTokens: usage?.cache_read_input_tokens ?? null,
    cacheWriteInputTokens: usage?.cache_creation_input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
    reasoningTokens: usage?.output_tokens_details?.thinking_tokens ?? null,
    peakInputTokens: messages.size ? Math.max(...[...messages.values()].map(m => input(m.usage))) : null,
    requests: messages.size, calls: toolCalls.length,
    tools: toolCalls.map(c => c.name), modelMs: result?.duration_api_ms ?? null,
    actualModels: Object.keys(result?.modelUsage ?? {}), permissionDenials: result?.permission_denials ?? [],
    // This is a provider list-price estimate, not the charge to a subscription.
    listPriceEstimateUSD: result?.total_cost_usd ?? null,
  };
}
export function codexMetrics(events: any[]) {
  const terminal = events.filter(e => e.type === "turn.completed");
  const completed = events.filter(e => e.type === "item.completed").map(e => e.item);
  const usages = terminal.map(e => e.usage).filter(Boolean);
  const sum = (key: string) => usages.length && usages.every(u => typeof u[key] === "number") ? usages.reduce((n, u) => n + u[key], 0) : null;
  const calls = completed.filter(i => ["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(i.type));
  return {
    answer: completed.filter(i => i.type === "agent_message").at(-1)?.text ?? "",
    error: events.findLast(e => e.type === "turn.failed")?.error?.message ?? (!terminal.length ? "No completed turn" : undefined),
    inputTokens: sum("input_tokens"), cachedInputTokens: sum("cached_input_tokens"), cacheWriteInputTokens: sum("cache_write_input_tokens"),
    outputTokens: sum("output_tokens"), reasoningTokens: sum("reasoning_output_tokens"),
    // exec JSON reports aggregate turn usage, not per-request usage or peak context.
    peakInputTokens: null, requests: null, calls: calls.length, tools: calls.map(c => c.type), modelMs: null,
    actualModels: [], permissionDenials: [], listPriceEstimateUSD: null,
  };
}
