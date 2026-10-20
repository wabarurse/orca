import { describe, expect, test } from "bun:test";
import { recentModels } from "./commands";

describe("recentModels", () => {
  const ids = ["m6", "m5", "m4", "m3", "m2", "m1", "m0"];
  test("keeps the newest few", () => {
    expect(recentModels(ids, "m5", 3)).toEqual(["m6", "m5", "m4"]);
  });
  test("adds the current model when it is older than the cut", () => {
    expect(recentModels(ids, "m0", 3)).toEqual(["m6", "m5", "m4", "m0"]);
  });
  test("ignores a current model the provider does not list", () => {
    expect(recentModels(ids, "other", 3)).toEqual(["m6", "m5", "m4"]);
  });
});
