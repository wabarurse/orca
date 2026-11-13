import { expect, test } from "bun:test";
import { diagnoseModelError } from "./model-diagnostics";

test("many-image rejection explains recovery without leaking the provider payload", () => {
  const error = diagnoseModelError({ status: 400, error: { type: "invalid_request_error",
    message: "messages.12.content.0.image: For many-image requests, each image dimension must be <= 3000 pixels. PRIVATE" } });
  expect(error.reason).toBe("image-limit");
  expect(error.message).toContain("/compact");
  expect(error.message).not.toContain("PRIVATE");
  expect(error.kind).toBe("permanent");
  expect(diagnoseModelError({ status: 400, error: { type: "invalid_request_error", message: "Invalid tool schema" } }).reason).toBe("invalid-request");
});
