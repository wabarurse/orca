import type { Message } from "@anthropic-ai/sdk/resources/messages";
import type { ResponseOutputItem } from "openai/resources/responses/responses";

// Synthetic fixtures following the published native schemas, NOT live captures.
export function claudeSearchFixture(): Message {
  return {
    id: "msg_search", type: "message", role: "assistant", model: "claude-test", stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [
      { type: "server_tool_use", id: "srv_search", name: "web_search", input: { query: "public docs" } },
      { type: "web_search_tool_result", tool_use_id: "srv_search", content: [
        { type: "web_search_result", title: "Public docs", url: "https://example.com/docs", encrypted_content: "opaque-search-content" },
        { type: "web_search_result", title: "Second source", url: "https://example.org/guide", encrypted_content: "opaque-other-content" },
      ] },
      { type: "text", text: "A generated answer (not a snippet).", citations: [
        { type: "web_search_result_location", url: "https://example.com/docs", title: "Public docs", cited_text: "An actual quoted excerpt.", encrypted_index: "opaque-citation-index" },
      ] },
    ],
  } as Message;
}
export function codexSearchFixture(): ResponseOutputItem[] {
  return [
    { type: "web_search_call", id: "ws_search", status: "completed", action: { type: "search", query: "public docs" } },
    { type: "message", id: "msg_search", status: "completed", role: "assistant", content: [
      { type: "output_text", text: "A generated answer (not a snippet).", annotations: [
        { type: "url_citation", url: "https://example.com/docs", title: "Public docs", start_index: 0, end_index: 10 },
        { type: "url_citation", url: "https://example.org/guide", title: "Second source", start_index: 11, end_index: 20 },
      ] },
    ] },
  ];
}
