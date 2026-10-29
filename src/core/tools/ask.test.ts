import { describe, expect, test } from "bun:test";
import { ask } from "./ask";

// Check the instructions actually exposed to the model, not a prose snapshot.
const description = ask.spec.description ?? "";

describe("ask policy", () => {
  test("reserves questions for consequential unresolved decisions needed now", () => {
    expect(description).toMatch(/Ask only for a currently unresolved decision or missing information needed now/);
    expect(description).toMatch(/materially affects scope\/results/);
    expect(description).toContain("destructive/data-loss risk");
    expect(description).toMatch(/new access, credentials, provider or billing beyond existing authorization/);
    expect(description).toMatch(/Do not treat real scope expansion or destructive changes as routine/);
  });

  test("avoids routine reapproval and chooses harmless reversible assumptions", () => {
    expect(description).toMatch(/Do not ask about routine implementation details, local tests, debugging, review or bounded verification within an approved task/);
    expect(description).toContain("or repeatedly seek approval for its normal steps");
    expect(description).toMatch(/harmless reversible details, preserve established behavior or state a reasonable assumption/);
    expect(description).toMatch(/No speculative questions for paused\/later work, status updates/);
    expect(description).toMatch(/'shall I continue\?' when continuation is already authorized/);
  });

  test("uses known context and chat answers, and closes questions answered in chat or outdated", () => {
    expect(description).toMatch(/Before asking, use known project requirements, conversation/);
    expect(description).toMatch(/any known pending question IDs\/content to avoid duplicating unanswered questions/);
    expect(description).toMatch(/Honor clear answers and authorization already given in chat/);
    expect(description).toMatch(/do not repeat approvals just because they were not clicked in Ctrl\+Q/);
    expect(description).not.toContain("cannot list or close");
    expect(description).toContain("Chat replies do not close questions by themselves");
    expect(description).toMatch(/action list shows this project's pending questions/);
    expect(description).toMatch(/answers one in chat, or it becomes outdated, close it/);
    expect(description).toMatch(/sends no reply and records no answer/);
    expect(description).toMatch(/their answer always wins/);
  });

  test("batches only necessary related decisions and continues unaffected work asynchronously", () => {
    expect(description).toMatch(/Returns ids at once; answers arrive later in your inbox/);
    expect(description).toMatch(/Batch genuinely related necessary decisions in one call/);
    expect(description).toContain("keep questions/options concise");
    expect(description).toContain("optionally include a suggested default");
    expect(description).toContain("keep working on unaffected parts");
  });

  test("Skip silently dismisses, never applying a default or granting approval", () => {
    expect(description).toContain("Skip silently removes a question from Inbox without sending you a reply or resuming work");
    expect(description).toContain("A default is only a suggestion the user may explicitly answer with");
    expect(description).toMatch(/Skip, silence and closing the panel never apply it/);
    expect(description).toMatch(/Never use a default, Skip or silence to authorize destructive steps/);
    expect(description).toContain("or bypass explicit execution authorization for the shown branch plan");
  });

  test("keeps the input contract and limits while clarifying the safe default", () => {
    expect(ask.spec.name).toBe("ask");
    expect(ask.spec.input_schema).toEqual({
      type: "object",
      properties: {
        action: { type: "string", enum: ["ask", "list", "close"], description: expect.stringContaining("ask (default)") },
        questions: {
          type: "array",
          description: "ask: at most 10.",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "At most 500 chars." },
              options: { type: "array", items: { type: "string" }, description: "Short choices, at most 8." },
              default: {
                type: "string",
                description: expect.stringMatching(/Optional suggested answer.*never applied by Skip, silence or closing the panel.*never permission.*destructive steps.*unapproved plan.*100 chars/),
              },
            },
            required: ["text"],
          },
        },
        ids: { type: "array", items: { type: "string" }, description: expect.stringContaining("at most 20") },
        reason: { type: "string", description: expect.stringContaining("At most 200 chars") },
      },
      required: [],
    });
  });
});
