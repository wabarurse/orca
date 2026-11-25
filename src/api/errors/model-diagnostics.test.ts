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

test("a rate limit names which limit it hit from the provider's message, without echoing it", () => {
  const limited = (message: string) => diagnoseModelError({ status: 429, error: { type: "rate_limit_error", message } }, false, "connection");
  const long = limited("Extra usage is required for long context requests. PRIVATE");
  expect(long.reason).toBe("rate-limit");
  expect(long.message).toContain("long-context requests (over 200k tokens)");
  expect(long.message).toContain("HTTP 429.");
  expect(long.message).not.toContain("PRIVATE");
  expect(limited("This request would exceed the rate limit of 400,000 input tokens per minute.").message).toContain("input-tokens-per-minute");
  expect(limited("something else PRIVATE").message).toBe("Provider rate limit. Wait before resuming. The remaining account allowance is unknown. HTTP 429.");
});
