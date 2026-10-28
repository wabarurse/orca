import { expect, test } from "bun:test";
import { entryNotice, transcriptStatus } from "./notices";
import type { Entry, ModelRequestEntry } from "../../protocol";

const base = { uuid: "request", parentUuid: null, ts: "" };
const request = (stage: ModelRequestEntry["stage"]): Entry => ({ ...base, type: "model-request", requestId: "r", provider: "anthropic", model: "m", stage, startedAt: "x", updatedAt: "y" });
test("all request outcomes are status notices, including error and aborted", () => {
  for (const stage of ["preparing", "provider-wait", "completed", "error", "aborted"] as const) {
    expect(entryNotice(request(stage))).toBe(`[model request] anthropic/m ${stage}; started x; updated y`);
  }
  expect(entryNotice({ ...base, type: "message", message: { role: "assistant", content: "real reply" } })).toBeUndefined();
});
test("restored status uses the latest metadata in the current clear scope", () => {
  const before = request("aborted");
  const boundary: Entry = { ...base, uuid: "clear", type: "context-boundary" };
  const after = { ...request("completed"), uuid: "new" };
  expect(transcriptStatus([before]).notice?.text).toContain("aborted");
  expect(transcriptStatus([before, boundary])).toEqual({ boundary: "clear", notice: undefined });
  expect(transcriptStatus([before, boundary, after])).toEqual({ boundary: "clear", notice: { id: "new", text: entryNotice(after)! } });
});
