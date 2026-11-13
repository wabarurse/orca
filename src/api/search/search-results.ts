import type { ContentBlock, Message, WebSearchResultBlock } from "@anthropic-ai/sdk/resources/messages";
import type { ResponseFunctionWebSearch, ResponseOutputItem, ResponseOutputMessage } from "openai/resources/responses/responses";
import { SearchError, type SearchResult, type SearchSource } from "./web-search";

const CLAUDE_BLOCKS = new Set(["server_tool_use", "web_search_tool_result", "text", "thinking", "redacted_thinking"]);
function claudeCalls(content: ContentBlock[]): Set<string> {
  const ids = new Set<string>();
  for (const block of content) {
    if (!CLAUDE_BLOCKS.has(block.type)) throw new SearchError("action");
    if (block.type !== "server_tool_use") continue;
    if (block.name !== "web_search" || !block.id || ids.has(block.id)) throw new SearchError("incomplete");
    ids.add(block.id);
  }
  if (!ids.size) throw new SearchError("no_search");
  return ids;
}
function claudeSource(source: WebSearchResultBlock): SearchSource {
  if (source.type !== "web_search_result" || typeof source.url !== "string" || typeof source.title !== "string") throw new SearchError("sources");
  return { url: source.url, title: source.title };
}
function claudeCitations(block: ContentBlock): SearchSource[] {
  if (block.type !== "text") return [];
  // cited_text is actual provider-supplied quoted content, unlike generated text.
  return (block.citations ?? []).flatMap(citation => citation.type === "web_search_result_location"
    ? [{ url: citation.url, ...(citation.title ? { title: citation.title } : {}), excerpt: citation.cited_text }] : []);
}

/** Extract only structured native results/citations, never model-invented JSON or
 * prose. The disposable hosted-search exchange is not replayed as main history. */
export function claudeSearchResults(message: Message): SearchResult {
  if (message.stop_reason === "refusal") throw new SearchError("refusal");
  if (message.stop_reason !== "end_turn" || !Array.isArray(message.content)) throw new SearchError("incomplete");
  const pending = claudeCalls(message.content);
  const sources: SearchSource[] = [];
  for (const block of message.content) {
    if (block.type !== "web_search_tool_result") continue;
    if (!pending.delete(block.tool_use_id)) throw new SearchError("malformed");
    if (!Array.isArray(block.content)) throw new SearchError("native");
    sources.push(...block.content.map(claudeSource));
  }
  if (pending.size) throw new SearchError("native");
  return { sources: [...sources, ...message.content.flatMap(claudeCitations)] };
}

function codexSources(item: ResponseFunctionWebSearch): SearchSource[] {
  if (item.status !== "completed") throw new SearchError("native");
  if (!item.action || typeof item.action.type !== "string") throw new SearchError("malformed");
  if (item.action.type !== "search") throw new SearchError("action");
  if (item.action.sources != null && !Array.isArray(item.action.sources)) throw new SearchError("malformed");
  return (item.action.sources ?? []).filter(source => source?.type === "url").map(source => ({ url: source.url }));
}
function codexCitations(item: ResponseOutputMessage): SearchSource[] {
  if (item.status !== "completed" || !Array.isArray(item.content)) throw new SearchError("incomplete");
  return item.content.flatMap(part => {
    if (part?.type === "refusal") throw new SearchError("refusal");
    if (part?.type !== "output_text") throw new SearchError("malformed");
    if (part.annotations != null && !Array.isArray(part.annotations)) throw new SearchError("malformed");
    return (part.annotations ?? []).flatMap(citation => citation?.type === "url_citation"
      ? [{ url: citation.url, title: citation.title }] : []);
  });
}
/** Also validate every streamed done item, so a terminal output array cannot
 * hide a failed native action by omitting or replacing it. */
export function codexSearchItemSources(item: ResponseOutputItem): SearchSource[] {
  if (!item || typeof item !== "object") throw new SearchError("malformed");
  switch (item.type) {
    case "web_search_call": return codexSources(item);
    case "message": return codexCitations(item);
    case "reasoning":
      if (item.status !== undefined && item.status !== "completed") throw new SearchError("incomplete");
      return [];
    default: throw new SearchError("action");
  }
}
export function codexSearchResults(output: ResponseOutputItem[]): SearchResult {
  if (!Array.isArray(output)) throw new SearchError("malformed");
  const sources = output.flatMap(codexSearchItemSources);
  if (!output.some(item => item.type === "web_search_call")) throw new SearchError("no_search");
  // No citations is not proof of zero hits. Codex may omit its source metadata;
  // do not turn a prose claim or an empty answer into a successful search.
  if (!sources.length) throw new SearchError("sources");
  return { sources };
}
