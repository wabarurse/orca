import type { ContentBlock, Message, WebSearchResultBlock } from "@anthropic-ai/sdk/resources/messages";
import type { ResponseFunctionWebSearch, ResponseOutputItem, ResponseOutputMessage } from "openai/resources/responses/responses";
import { SearchError, type SearchResult, type SearchSource } from "./web-search";
import { fail, ok, type Result } from "../../config";

type Sources = Result<SearchSource[], SearchError>;
const refuse = (code: SearchError["code"]): { ok: false; error: SearchError } => fail(new SearchError(code));

function collect<T>(items: readonly T[], each: (item: T) => Sources): Sources {
  const sources: SearchSource[] = [];
  for (const item of items) {
    const found = each(item);
    if (!found.ok) return found;
    sources.push(...found.data);
  }
  return ok(sources);
}

const CLAUDE_BLOCKS = new Set(["server_tool_use", "web_search_tool_result", "text", "thinking", "redacted_thinking"]);
function claudeCalls(content: ContentBlock[]): Result<Set<string>, SearchError> {
  const ids = new Set<string>();
  for (const block of content) {
    if (!CLAUDE_BLOCKS.has(block.type)) return refuse("action");
    if (block.type !== "server_tool_use") continue;
    if (block.name !== "web_search" || block.id === "" || ids.has(block.id)) return refuse("incomplete");
    ids.add(block.id);
  }
  if (ids.size === 0) return refuse("no_search");
  return ok(ids);
}
function claudeSource(source: WebSearchResultBlock): Sources {
  if (source.type !== "web_search_result" || typeof source.url !== "string" || typeof source.title !== "string") return refuse("sources");
  return ok([{ url: source.url, title: source.title }]);
}
function claudeCitations(block: ContentBlock): SearchSource[] {
  if (block.type !== "text") return [];
  return (block.citations ?? []).flatMap(citation => citation.type === "web_search_result_location"
    ? [{ url: citation.url, ...(citation.title !== null && citation.title !== "" ? { title: citation.title } : {}), excerpt: citation.cited_text }] : []);
}

export function claudeSearchResults(message: Message): Result<SearchResult, SearchError> {
  if (message.stop_reason === "refusal") return refuse("refusal");
  if (message.stop_reason !== "end_turn" || !Array.isArray(message.content)) return refuse("incomplete");
  const calls = claudeCalls(message.content);
  if (!calls.ok) return calls;
  const pending = calls.data;
  const sources: SearchSource[] = [];
  for (const block of message.content) {
    if (block.type !== "web_search_tool_result") continue;
    if (!pending.delete(block.tool_use_id)) return refuse("malformed");
    if (!Array.isArray(block.content)) return refuse("native");
    const found = collect(block.content, claudeSource);
    if (!found.ok) return found;
    sources.push(...found.data);
  }
  if (pending.size > 0) return refuse("native");
  return ok({ sources: [...sources, ...message.content.flatMap(claudeCitations)] });
}

function codexSources(item: ResponseFunctionWebSearch): Sources {
  if (item.status !== "completed") return refuse("native");
  const action: unknown = item.action;
  if (action === null || action === undefined || typeof item.action.type !== "string") return refuse("malformed");
  if (item.action.type !== "search") return refuse("action");
  const listed: unknown = item.action.sources;
  if (listed !== null && listed !== undefined && !Array.isArray(listed)) return refuse("malformed");
  return ok((item.action.sources ?? []).filter(source => source?.type === "url").map(source => ({ url: source.url })));
}
function codexCitations(item: ResponseOutputMessage): Sources {
  if (item.status !== "completed" || !Array.isArray(item.content)) return refuse("incomplete");
  return collect(item.content, part => {
    const present: unknown = part;
    if (present === null || present === undefined) return refuse("malformed");
    if (part.type === "refusal") return refuse("refusal");
    if (part.type !== "output_text") return refuse("malformed");
    const annotations: unknown = part.annotations;
    if (annotations !== null && annotations !== undefined && !Array.isArray(annotations)) return refuse("malformed");
    return ok((part.annotations ?? []).flatMap(citation => citation?.type === "url_citation"
      ? [{ url: citation.url, title: citation.title }] : []));
  });
}
export function codexSearchItemSources(item: ResponseOutputItem): Sources {
  const present: unknown = item;
  if (present === null || typeof present !== "object") return refuse("malformed");
  switch (item.type) {
    case "web_search_call": return codexSources(item);
    case "message": return codexCitations(item);
    case "reasoning":
      if (item.status !== undefined && item.status !== "completed") return refuse("incomplete");
      return ok([]);
    default: return refuse("action");
  }
}
export function codexSearchResults(output: ResponseOutputItem[]): Result<SearchResult, SearchError> {
  if (!Array.isArray(output)) return refuse("malformed");
  const sources = collect(output, codexSearchItemSources);
  if (!sources.ok) return sources;
  if (!output.some(item => item.type === "web_search_call")) return refuse("no_search");
  if (sources.data.length === 0) return refuse("sources");
  return ok({ sources: sources.data });
}
