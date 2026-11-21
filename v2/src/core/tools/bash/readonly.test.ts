import { expect, test } from "bun:test";
import { readOnly } from "./readonly";
import { bash } from "./bash";

test("commands that only read may overlap", () => {
  for (const command of [
    "grep -rn 'foo' src | head -20",
    "cd packages/app && rg -n \"useState\" --glob '*.tsx'; ls -la src",
    "sed -n '60,135p' src/a.ts",
    "sed -n 10,20p a.ts; sed -n '1,5p;9,12p' b.ts",
    "cat a.ts | wc -l",
    "git status --short && git diff --stat | tail -3",
    "git --no-pager log --oneline -5",
    "find . -name '*.ts' -newer package.json | sort | uniq -c",
    "ls missing 2>/dev/null || echo none",
    "grep -c x a.txt 2>&1",
    "jq '.scripts' package.json",
  ]) expect([command, readOnly(command)]).toEqual([command, true]);
});

test("anything that may write, run another program or is not recognised stays in order", () => {
  for (const command of [
    "",
    "echo hi > out.txt",
    "cat a >> b",
    "sed -i '' 's/a/b/' f.ts",
    "sed 's/a/b/' f.ts",
    "sed -n '1,5w out.txt' f.ts",
    "sed -n '/x/p' f.ts",
    "find . -name '*.tmp' -delete",
    "find . -type f -exec rm {} +",
    "grep -l foo -r . | xargs rm",
    "git checkout main",
    "git diff --output=patch.diff",
    "git commit -m 'x'",
    "sort -o a.txt a.txt",
    "uniq a.txt b.txt",
    "rg --pre ./run foo",
    "ls $(rm -rf x)",
    "ls `whoami`",
    "ls \"$(rm -rf x)\"",
    "grep \"`date`\" a.txt",
    "(cd x; ls)",
    "sleep 1 & ls",
    "bun test",
    "FOO=1 ls",
    "for f in *; do cat $f; done",
    "python3 - <<'EOF2'\nprint(1)\nEOF2",
    "cat <<'EOF2' > x\nhi\nEOF2",
    "tee out.txt",
    "awk '{print > \"x\"}' f",
    "rm -rf build",
  ]) expect([command, readOnly(command)]).toEqual([command, false]);
});

test("bash overlaps a read-only foreground command without the flag, and never a background one", () => {
  expect(bash.parallel!({ command: "grep -n foo a.ts" })).toBe(true);
  expect(bash.parallel!({ command: "bun test" })).toBe(false);
  expect(bash.parallel!({ command: "bun test", independent: true })).toBe(true);
  expect(bash.parallel!({ command: "cat a.log", background: true })).toBe(false);
  expect(bash.parallel!({ command: "cat a.log", yield_ms: 100 })).toBe(false);
  expect(bash.parallel!({})).toBe(false);
});
