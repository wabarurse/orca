import { ok } from "../../config";
import { mutate } from "./atomic";
import { filePath } from "./path";
import { settled, type Tool } from "./registry";

export const write: Tool = {
  parallel: () => false,
  spec: { name: "write", description: "Create a UTF-8 file, or replace it with expected_revision from read. The parent directory must exist. Existing content is never overwritten without a matching revision; writing to an existing path without one fails and reports its current revision, to retry with or to use edit instead.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, expected_revision: { type: "string" } }, required: ["path", "content"] } },
  async run(input, ctx) {
    if (typeof input.content !== "string") throw new Error("content must be a string");
    const text = input.content;
    return settled(await mutate(settled(await filePath(input.path, ctx, true)), input.expected_revision, () => ok({ text, report: {} }), input.expected_revision === undefined));
  },
};
