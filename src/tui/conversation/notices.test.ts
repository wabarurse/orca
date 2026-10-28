import { expect, test } from "bun:test";
import { entryNotice } from "./notices";
import type { Entry, ModelRequestEntry } from "../../protocol";

const base = { uuid: "request", parentUuid: null, ts: "" };
const request = (stage: ModelRequestEntry["stage"]): Entry => ({ ...base, type: "model-request", requestId: "r", provider: "anthropic", model: "m", stage, startedAt: "x", updatedAt: "y" });
test("all request outcomes are status notices, including error and aborted", () => {
  for (const stage of ["preparing", "provider-wait", "completed", "error", "aborted"] as const) {
    expect(entryNotice(request(stage))).toBe(`[model request] anthropic/m ${stage}; started x; updated y`);
  }
  expect(entryNotice({ ...base, type: "message", message: { role: "assistant", content: "real reply" } })).toBeUndefined();
});
