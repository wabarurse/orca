import { describe, expect, test } from "bun:test";
import { formatScores, scoreSource } from "./complexity";

const one = (src: string, name?: string) => {
  const scores = scoreSource(src);
  const s = name ? scores.find((x) => x.name === name) : scores[0];
  if (!s) throw new Error(`no function ${name} in ${scores.map((x) => x.name)}`);
  return s;
};

describe("cyclomatic", () => {
  test("a straight-line function is 1", () => {
    expect(one("function f() { return 1; }").cyclomatic).toBe(1);
  });
  test("each decision point adds one", () => {
    const src = `function f(a, b) {
      if (a) {}            // +1
      for (;;) {}          // +1
      while (a) {}         // +1
      switch (a) { case 1: break; case 2: break; default: }  // +2
      try {} catch (e) {}  // +1
      const x = a ? 1 : 2; // +1
      return (a && b) || (a ?? b); // +3
    }`;
    expect(one(src).cyclomatic).toBe(1 + 1 + 1 + 1 + 2 + 1 + 1 + 3);
  });
  test("nested functions are scored on their own, not in the parent", () => {
    const src = `function outer() { const inner = () => { if (x) {} if (y) {} }; return inner; }`;
    expect(one(src, "outer").cyclomatic).toBe(1);
    expect(one(src, "inner").cyclomatic).toBe(3);
  });
});

describe("cognitive", () => {
  test("nesting adds the depth", () => {
    const src = `function f(a, b, c) {
      if (a) {           // +1
        for (;;) {       // +2 (nested once)
          while (b) {}   // +3 (nested twice)
        }
      }
    }`;
    expect(one(src).cognitive).toBe(6);
  });
  test("else and else-if add one without the nesting penalty", () => {
    const src = `function f(a) {
      if (a) {}          // +1
      else if (a) {}     // +1
      else {}            // +1
    }`;
    expect(one(src).cognitive).toBe(3);
  });
  test("runs of logical operators count once per operator change", () => {
    expect(one("function f(a,b,c){ return a && b && c; }").cognitive).toBe(1);
    expect(one("function f(a,b,c){ return a && b || c; }").cognitive).toBe(2);
    expect(one("function f(a,b,c,d){ return a && b || c && d; }").cognitive).toBe(3);
  });
  test("recursion adds one and a nested lambda adds nesting", () => {
    expect(one("function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }").cognitive).toBe(2); // ?: +1, recursion +1
    const src = `function f(xs) { return xs.map((x) => { if (x) return 1; return 0; }); }`;
    expect(one(src, "f").cognitive).toBe(2); // if at nesting 1 inside the lambda
  });
  test("a switch counts once, not per case", () => {
    expect(one("function f(a){ switch (a) { case 1: return 1; case 2: return 2; default: return 0; } }").cognitive).toBe(1);
  });
});

describe("names and formats", () => {
  test("names come from declarations, assignments, properties and methods", () => {
    const src = `
      function decl() {}
      const arrow = () => {};
      obj.method = function () {};
      const o = { prop() {}, key: () => {} };
      class C { m() {} static s() {} }
      export default function () {}
    `;
    expect(scoreSource(src).map((s) => s.name)).toEqual(["decl", "arrow", "obj.method", "prop", "key", "m", "s", "<anonymous>"]);
  });
  test("TypeScript and JSX parse", () => {
    expect(scoreSource("const f = (x: number): string => x > 1 ? 'a' : 'b';", "a.ts")[0]).toMatchObject({ name: "f", cyclomatic: 2 });
    expect(scoreSource("const C = () => <div>{ok ? 1 : 2}</div>;", "a.tsx")[0]).toMatchObject({ name: "C", cyclomatic: 2 });
  });
  test("the table flags functions over the thresholds", () => {
    const table = formatScores([
      { file: "a.ts", name: "ok", line: 1, cyclomatic: 2, cognitive: 1 },
      { file: "a.ts", name: "big", line: 9, cyclomatic: 12, cognitive: 3 },
    ], { cyclomatic: 10, cognitive: 15 });
    expect(table.split("\n")[2]).toBe("| a.ts | big | 9 | 12 | 3 | over |");
    expect(table).toContain("2 functions, 1 over the thresholds (cyclomatic > 10, cognitive > 15)");
  });
});
