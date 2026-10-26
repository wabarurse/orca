import { describe, expect, test } from "bun:test";
import { fitColumns, inline, renderBlock, renderLabelled, renderMarkdown, sourceLines, takeBlocks, wordWrap } from "./markdown";
import { MarkdownStream } from "./mdstream";
import { commit } from "../components/render";
import { FakeScreen } from "../components/testing";

/** What the lines look like committed to a real terminal `cols` wide (FakeScreen throws on any escape it does not model). */
function show(lines: string[], cols: number): string[] {
  const screen = new FakeScreen(cols, 4);
  screen.write(commit(lines, cols));
  return screen.text().split("\n").slice(0, lines.length);
}
const md = (text: string, cols = 60) => show(renderMarkdown(text, cols), cols);
const plain = (s: string) => s.replace(/\x1b\[[0-9;:]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
const width = (s: string) => Bun.stringWidth(s);

describe("inline", () => {
  test("bold, italic, strike and code have their own styles; nested spans restore the outer style", () => {
    expect(inline("a **b** c")).toBe("a \x1b[1mb\x1b[0m c");
    expect(inline("*i* and _j_")).toBe("\x1b[3mi\x1b[0m and \x1b[3mj\x1b[0m");
    expect(inline("~~gone~~")).toBe("\x1b[9mgone\x1b[0m");
    expect(inline("run `ls -la` now")).toBe("run \x1b[36mls -la\x1b[0m now");
    expect(inline("**bold *both* bold**")).toBe("\x1b[1mbold \x1b[3mboth\x1b[0m\x1b[1m bold\x1b[0m");
    expect(inline("***both***")).toBe("\x1b[1m\x1b[3mboth\x1b[0m");
  });

  test("snake_case, 2*3 and other intraword or spaced delimiters stay literal", () => {
    for (const s of ["snake_case_name", "2*3", "2*3*4", "a * b * c", "file_name and other_name", "**", "a ** b", "x_", "_ spaced _", "price*", "~single~"]) {
      expect(inline(s)).toBe(s);
    }
    expect(inline("use my_var, not *your_var*")).toBe("use my_var, not \x1b[3myour_var\x1b[0m");
  });

  test("nested emphasis closes on its own run; code spans and escapes never close it", () => {
    expect(inline("*a **b** c*")).toBe("\x1b[3ma \x1b[1mb\x1b[0m\x1b[3m c\x1b[0m");
    expect(inline("*ital **bold** ital*")).toBe("\x1b[3mital \x1b[1mbold\x1b[0m\x1b[3m ital\x1b[0m");
    expect(inline("**a *b* c**")).toBe("\x1b[1ma \x1b[3mb\x1b[0m\x1b[1m c\x1b[0m");
    expect(inline("**a *b***")).toBe("\x1b[1ma \x1b[3mb\x1b[0m\x1b[1m\x1b[0m");
    expect(inline("**a***")).toBe("\x1b[1ma\x1b[0m*");
    expect(inline("*a `*` b*")).toBe("\x1b[3ma \x1b[36m*\x1b[0m\x1b[3m b\x1b[0m");
    expect(inline("**a\\**")).toBe("**a**"); // the escaped star is text: nothing closes the bold
    expect(inline("*a\\* b*")).toBe("\x1b[3ma* b\x1b[0m");
  });

  test("backslash escapes and code spans keep markdown characters literal", () => {
    expect(inline("\\*not italic\\*")).toBe("*not italic*");
    expect(inline("`a*b*c` and ``x ` y``")).toBe("\x1b[36ma*b*c\x1b[0m and \x1b[36mx ` y\x1b[0m");
    expect(inline("an `unclosed span")).toBe("an `unclosed span");
  });

  test("links are OSC 8 hyperlinks showing the text, with the URL after it when they differ", () => {
    const a = inline("see [the docs](https://x.dev/a_b)");
    expect(a).toContain("\x1b]8;;https://x.dev/a_b\x1b\\the docs\x1b]8;;\x1b\\");
    expect(plain(a)).toBe("see the docs (https://x.dev/a_b)");
    expect(plain(inline("[https://x.dev](https://x.dev)"))).toBe("https://x.dev");
    expect(plain(inline("<https://x.dev/q>"))).toBe("https://x.dev/q");
    expect(inline("[a](https://x.dev/\x07\x1b)")).not.toContain("\x07");

  });

  test("bare web URLs and displayed destinations are explicit safe links, including wrapped targets", () => {
    const url = "https://example.com/path_(item)";
    const out = inline(`See ${url}.`);
    expect(out).toBe(`See \x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\.`);
    expect(inline(`[docs](${url})`)).toContain(`\x1b]8;;${url}\x1b\\(${url})`);
    const rows = wordWrap(out, 12);
    expect(rows.filter(row => row.includes("\x1b]8;;https://")).length).toBeGreaterThan(1);
    expect(inline("`https://example.com`")).not.toContain("\x1b]8");
    for (const bad of ["https://", "https://user:pass@example.com", "javascript:alert(1)", "file:///tmp/a", "https://example.com/\x07", "https://example.com/\u202eabc"]) {
      expect(inline(`[label](${bad})`)).not.toContain("\x1b]8");
    }
  });

  test("styled link labels never nest OSC 8 or lose their enclosing target", () => {
    const outer = "https://outer.example";
    const open = `\x1b]8;;${outer}\x1b\\`;
    const close = "\x1b]8;;\x1b\\";
    for (const label of [
      "**https://inner.example** tail",
      "*before **https://inner.example** after* tail",
      "~~https://inner.example~~ tail",
      "**<https://inner.example>** tail",
      "**[inner](https://inner.example)** tail",
    ]) {
      const out = inline(`[${label}](${outer})`);
      // One open/close for the whole label, then one for the shown destination.
      expect(out.match(/\x1b\]8;;[^\x1b]*\x1b\\/g)).toEqual([open, close, open, close]);
      const labelOutput = out.slice(open.length, out.indexOf(close));
      expect(plain(labelOutput)).toContain("https://inner.example");
      expect(plain(labelOutput)).toEndWith(" tail");
      expect(labelOutput).toContain("\x1b["); // emphasis is still rendered
      for (const row of wordWrap(out, 12)) {
        const targets = [...row.matchAll(/\x1b\]8;;([^\x1b]+)\x1b\\/g)].map(hit => hit[1]);
        expect(targets.every(target => target === outer)).toBe(true);
      }
    }
    // Outside labels, recursive spans should still linkify normally.
    expect(inline("**https://inner.example**")).toContain("\x1b]8;;https://inner.example\x1b\\");
  });

  test("bare URLs exclude unmatched prose closers but retain balanced brackets and IPv6", () => {
    for (const [text, url] of [
      ["[https://example.com/path]", "https://example.com/path"],
      ["{https://example.com/path}", "https://example.com/path"],
      ["([https://example.com/path]).", "https://example.com/path"],
      ["‘https://example.com/path’", "https://example.com/path"],
      ["'https://example.com/path'", "https://example.com/path"],
      ["https://example.com/a[b]", "https://example.com/a[b]"],
      ["https://example.com/a{b}", "https://example.com/a{b}"],
      ["[https://[::1]]", "https://[::1]"],
      ["[https://[2001:db8::1]:8443/a[b]].", "https://[2001:db8::1]:8443/a[b]"],
    ]) {
      const out = inline(text!);
      expect(plain(out)).toBe(text!);
      expect([...out.matchAll(/\x1b\]8;;([^\x1b]+)\x1b\\/g)].map(hit => hit[1])).toEqual([url!]);
    }
  });

  test("URLs may hold balanced parentheses; empty text shows the URL; only http(s) and mailto become links", () => {
    const paren = inline("[x](https://e.com/a_(b)_c) after");
    expect(paren).toContain("\x1b]8;;https://e.com/a_(b)_c\x1b\\x\x1b]8;;\x1b\\");
    expect(plain(paren)).toBe("x (https://e.com/a_(b)_c) after");
    expect(plain(inline("[x](https://e.com/(a)/(b))"))).toBe("x (https://e.com/(a)/(b))");
    const empty = inline("[](https://e.com)");
    expect(empty).toBe("\x1b]8;;https://e.com\x1b\\https://e.com\x1b]8;;\x1b\\");
    expect(inline("[mail](mailto:a@b.c)")).toContain("\x1b]8;;mailto:a@b.c");
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "./README.md"]) {
      const out = inline(`[click](${url})`);
      expect(out).not.toContain("\x1b]8");
      expect(plain(out)).toBe(`click (${url})`);
    }
  });
});

describe("wordWrap", () => {
  test("wraps at spaces by display width and carries styles and links across the break", () => {
    const lines = wordWrap(inline("one **two three four** [five six](https://f.dev)"), 10);
    expect(lines.map(plain)).toEqual(["one two", "three four", "five six", "(https://f", ".dev)"]);
    expect(lines[1]!.startsWith("\x1b[1m")).toBe(true); // bold reopened
    expect(lines[2]).toContain("\x1b]8;;https://f.dev\x1b\\");
    expect(lines.every((l) => width(l) <= 10)).toBe(true);
  });

  test("CJK breaks between characters; a word longer than the line is cut", () => {
    expect(wordWrap("中文字符测试", 5).map(plain)).toEqual(["中文", "字符", "测试"]);
    expect(wordWrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(wordWrap("see abcdefghij", 6)).toEqual(["see", "abcdef", "ghij"]);
  });
});

describe("blocks", () => {
  test("headings are bold, level 1 underlined too; the # marks go", () => {
    const [h1, h2] = renderMarkdown("# Top\n## Sub", 40);
    expect(h1).toBe("\x1b[1m\x1b[4mTop\x1b[0m");
    expect(h2).toBe("\x1b[1mSub\x1b[0m");
  });

  test("lists: wrapped lines indent under the text, nested items keep their indent, numbers stay", () => {
    expect(md("- a list item that is long enough to wrap\n  - nested item here\n1. first\n10. tenth", 20)).toEqual([
      "- a list item that",
      "  is long enough to",
      "  wrap",
      "  - nested item here",
      "1. first",
      "10. tenth",
    ]);
  });

  test("quotes get a dim bar on every row, rules fill the width, blank runs become one blank line", () => {
    const lines = renderMarkdown("> quoted text that wraps over\n\n\n---", 16);
    expect(lines[0]).toBe("\x1b[2m│\x1b[0m quoted text");
    expect(lines.map(plain)).toEqual(["│ quoted text", "│ that wraps", "│ over", "", "─".repeat(16)]);
    expect(lines.at(-1)).toContain("\x1b[2m");
  });

  test("code blocks: dim gutter, language label, no markdown or wrapping inside unless wider than the screen", () => {
    const text = "```ts\nconst a_b = 2*3; // **not bold**\n  indented\n```";
    expect(md(text, 60)).toEqual(["│ ts", "│ const a_b = 2*3; // **not bold**", "│   indented"]);
    expect(md(text, 20)).toEqual(["│ ts", "│ const a_b = 2*3; /", "│ / **not bold**", "│   indented"]);
    expect(md("~~~\nx\n~~~")).toEqual(["│ x"]);
    expect(md("```\nnever closed")).toEqual(["│ never closed"]);
  });

  test("escapes and controls in the source never reach the terminal", () => {
    const lines = renderMarkdown("hi \x1b[2J\x1b]0;title\x07there\r", 40);
    expect(lines).toEqual(["hi there"]);
  });

  test("a reply's label leads a plain first line, or stands alone before a block", () => {
    expect(renderLabelled("me", "hello **you**", 40).map(plain)).toEqual(["me hello you"]);
    expect(renderLabelled("me", "- item", 40).map(plain)).toEqual(["me", "- item"]);
    expect(renderLabelled("me", "", 40)).toEqual(["me"]);
  });
});

const TABLE = [
  "| Branch | What it does | Status |",
  "|---|---|:---:|",
  "| tui-markdown | Render **markdown** in the chat area | open |",
  "| fix_bug | A `snake_case` fix | merged |",
].join("\n");

/** Columns of every vertical border on each row, to check they line up. */
const bars = (rows: string[]) => rows.map((r) => [...r].reduce<number[]>((at, c, i) => (/[│┌┐└┘├┤┬┴┼]/.test(c) ? [...at, width([...r].slice(0, i).join(""))] : at), []));

describe("tables", () => {
  test("box-drawn, bold header, aligned columns", () => {
    const rows = md(TABLE, 80);
    expect(rows).toEqual([
      "┌──────────────┬──────────────────────────────────┬────────┐",
      "│ Branch       │ What it does                     │ Status │",
      "├──────────────┼──────────────────────────────────┼────────┤",
      "│ tui-markdown │ Render markdown in the chat area │  open  │",
      "│ fix_bug      │ A snake_case fix                 │ merged │",
      "└──────────────┴──────────────────────────────────┴────────┘",
    ]);
    expect(renderMarkdown(TABLE, 80)[1]).toContain("\x1b[1mBranch\x1b[0m");
  });

  test("too wide: the widest column shrinks and its cells wrap, rows ruled apart", () => {
    const rows = md(TABLE, 44);
    expect(rows.every((r) => width(r) <= 44)).toBe(true);
    expect(rows).toEqual([
      "┌──────────────┬──────────────────┬────────┐",
      "│ Branch       │ What it does     │ Status │",
      "├──────────────┼──────────────────┼────────┤",
      "│ tui-markdown │ Render markdown  │  open  │",
      "│              │ in the chat area │        │",
      "├──────────────┼──────────────────┼────────┤",
      "│ fix_bug      │ A snake_case fix │ merged │",
      "└──────────────┴──────────────────┴────────┘",
    ]);
    const narrow = md(TABLE, 30);
    expect(narrow.every((r) => width(r) <= 30)).toBe(true);
    expect(new Set(bars(narrow).map(String)).size).toBe(1);
  });

  test("when no grid fits, one block per row as key: value", () => {
    expect(md(TABLE, 24)).toEqual([
      "Branch: tui-markdown",
      "What it does: Render",
      "  markdown in the chat",
      "  area",
      "Status: open",
      "",
      "Branch: fix_bug",
      "What it does: A",
      "  snake_case fix",
      "Status: merged",
    ]);
  });

  test("CJK and emoji cells are measured by display width", () => {
    const rows = md("| 名前 | 状態 |\n|---|---|\n| 中文テキスト | ✅ done |\n| 😀 | 🚀🚀 |", 40);
    expect(new Set(bars(rows).map(String)).size).toBe(1);
    expect(rows[3]).toBe("│ 中文テキスト │ ✅ done │");
    const squeezed = md("| 名前 | 説明 |\n|---|---|\n| 中文 | これはとても長い説明文です |", 24);
    expect(squeezed.every((r) => width(r) <= 24)).toBe(true);
    expect(new Set(bars(squeezed).map(String)).size).toBe(1);
  });

  test("alignment, missing and extra cells, escaped pipes and <br>", () => {
    const rows = md("| a | b |\n|--:|---|\n| 1 | x \\| y<br>z |\n| 22 |", 40);
    expect(rows).toEqual([
      "┌────┬───────┐",
      "│  a │ b     │",
      "├────┼───────┤",
      "│  1 │ x | y │",
      "│    │ z     │",
      "├────┼───────┤",
      "│ 22 │       │",
      "└────┴───────┘",
    ]);
  });

  test("fitColumns shrinks the widest first and gives up below the minimum", () => {
    expect(fitColumns([5, 30, 10], 50)).toEqual([5, 30, 10]);
    expect(fitColumns([5, 30, 10], 30)).toEqual([5, 15, 10]);
    expect(fitColumns([5, 30, 20], 30)).toEqual([5, 13, 12]);
    expect(fitColumns([20, 20, 20], 17)).toBeNull();
  });

  test("a header-only table keeps its header, as a grid or in the narrow fallback", () => {
    const only = "| Branch name | What it does | Status |\n|---|---|---|";
    expect(md(only, 60)).toEqual([
      "┌─────────────┬──────────────┬────────┐",
      "│ Branch name │ What it does │ Status │",
      "├─────────────┼──────────────┼────────┤",
      "└─────────────┴──────────────┴────────┘",
    ]);
    expect(md(only, 20)).toEqual(["Branch name", "What it does", "Status"]);
  });

  test("the fallback never overflows a tiny width", () => {
    for (const w of [1, 2, 3, 4, 5]) {
      const rows = renderMarkdown(TABLE, w);
      expect(rows.every((r) => width(r) <= w)).toBe(true);
    }
  });

  test("a delimiter row must have as many cells as the header", () => {
    expect(md("note | see below\n---")).toEqual(["note | see below", "─".repeat(60)]);
    expect(md("| a | b |\n|---|")).toEqual(["| a | b |", "|---|"]);
    expect(md("| a | b |\n|---|---|")[0]).toBe("┌───┬───┐");
  });

  test("a row line without a delimiter under it is just text", () => {
    expect(md("a | b\nnext")).toEqual(["a | b", "next"]);
  });
});

const DOC = [
  "",
  "# Plan",
  "Some **bold** text and snake_case.",
  "",
  "",
  "- one",
  "  - two",
  "```ts",
  "const x = 1;",
  "",
  "```",
  TABLE,
  "after the table",
  "> quote",
  "a | b",
  "",
  "| x | y |",
  "|---|---|",
  "| 1 | 2 |",
  "",
].join("\n");

/** Blocks from feeding `text` in chunks of `size`, then flushing. */
function chunked(text: string, size: number): string[] {
  const s = new MarkdownStream();
  const blocks: string[] = [];
  for (let i = 0; i < text.length; i += size) blocks.push(...s.feed(text.slice(i, i + size)));
  return [...blocks, ...s.flush()];
}

describe("streaming", () => {
  test("any chunking gives the same blocks and lines as one feed", () => {
    const whole = takeBlocks(sourceLines(DOC), true).blocks;
    const rendered = renderMarkdown(DOC, 50);
    for (const size of [1, 2, 3, 5, 7, 13, 1000]) {
      const blocks = chunked(DOC, size);
      expect(blocks).toEqual(whole);
      expect(blocks.flatMap((b) => renderBlock(b, 50))).toEqual(rendered);
    }
  });

  test("a trailing newline, an unclosed fence and other edge texts agree between the stream and the whole text", () => {
    const texts = ["a\n\n\n```\nx\n", "```\nx", "```\nx\n\n", "a\n", "a", "\n\n", "", "| a | b |\n|---|---|\n", "| a | b |\n|---|---|", "x | y\n"];
    for (const text of texts) {
      const whole = takeBlocks(sourceLines(text), true).blocks;
      for (const size of [1, 2, 3, 1000]) expect(chunked(text, size)).toEqual(whole);
    }
    expect(takeBlocks(sourceLines("a\n\n\n```\nx\n"), true).blocks).toEqual(["a", "", "```\nx"]);
  });

  test("lines go at once; a code block waits for its fence, a table for a non-row line, showing raw meanwhile", () => {
    const s = new MarkdownStream();
    expect(s.feed("\n\nHello **wor")).toEqual([]);
    expect(s.pending).toBe("Hello **wor");
    expect(s.feed("ld**\n- item\n```sh\nls\n")).toEqual(["Hello **world**", "- item"]);
    expect(s.pending).toBe("```sh\nls");
    expect(s.feed("```\n| a | b |\n")).toEqual(["```sh\nls\n```"]);
    expect(s.pending).toBe("| a | b |"); // a header, maybe
    expect(s.feed("|---|---|\n| 1 | 2 |\n")).toEqual([]);
    expect(s.pending).toBe("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(s.feed("\n")).toEqual(["| a | b |\n|---|---|\n| 1 | 2 |"]);
    expect(s.feed("\ndone")).toEqual([]);
    expect(s.flush()).toEqual(["", "done"]);
    expect(s.pending).toBe("");
    // The next reply starts fresh: leading blank lines are dropped again.
    expect(s.feed("\nnext\n")).toEqual(["next"]);
  });
});
