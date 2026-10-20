import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { pick } from "./picker";
import { recentModels } from "./repl";

function tty() {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = true;
  let written = "";
  const output = { write: (s: string) => { written += s; return true; } };
  return { input, output, text: () => written };
}

const choices = [
  { value: "a", label: "alpha" },
  { value: "b", label: "beta", current: true },
  { value: "c", label: "gamma" },
];

describe("pick", () => {
  test("starts on the current item and Enter picks it", async () => {
    const io = tty();
    const result = pick(choices, { io });
    io.input.write("\r");
    expect(await result).toBe("b");
  });

  test("arrow keys move and wrap", async () => {
    const io = tty();
    const result = pick(choices, { io });
    io.input.write("\x1b[B"); // down → gamma
    io.input.write("\x1b[B"); // wraps → alpha
    io.input.write("\r");
    expect(await result).toBe("a");
  });

  test("Esc cancels and restores readline's keypress listeners", async () => {
    const io = tty();
    const theirs = () => {};
    io.input.on("keypress", theirs);
    const result = pick(choices, { io });
    expect(io.input.listeners("keypress")).not.toContain(theirs);
    io.input.write("\x1b");
    expect(await result).toBeNull();
    expect(io.input.listeners("keypress")).toContain(theirs);
    expect(io.text()).toContain("\x1b[?25h"); // cursor shown again
  });

  test("without a TTY it just lists the choices", async () => {
    const io = tty();
    io.input.isTTY = false;
    expect(await pick(choices, { io, title: "T" })).toBeNull();
    expect(io.text()).toBe("T\n    alpha\n  ● beta\n    gamma\n");
  });

  test("no choices resolves null at once", async () => {
    expect(await pick([], { io: tty() })).toBeNull();
  });
});

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
