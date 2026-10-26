// The layout, enforced: CLAUDE.md "Layout" is the prose, this file is the check. It reads every src/**/*.ts
// import (static, export-from, side-effect, dynamic, `import("x").T` types, directory specifiers) and asserts
//   (a) packages point down: config < login < providers < protocol < core < exec · tui < cli, type-only included;
//   (b) inside a package, folders/files point down in the documented order (ORDER below);
//   (c) non-test code crossing a folder boundary imports that folder's barrel (`../../core/data/tasks`), never a deep
//       module; intra-folder imports stay direct and never go through the folder's own index.ts (a cycle);
//   (d) a barrel (index.ts) holds nothing but named re-exports of its own folder's files;
//   (e) src/ holds only the package folders, test/ and this file;
//   (f) size gates (SIZE), with DEBT listing today's offenders at their current numbers as ceilings that may only fall.
// Tests (*.test.ts, src/test/) may import deep modules and are exempt from (c); everything else applies to them too.
import { describe, expect, test } from "bun:test";
import { parse } from "@babel/parser";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";

const ROOT = import.meta.dir;
const PACKAGES = ["config", "login", "providers", "protocol", "core", "exec", "tui", "cli"];

type Order = { tiers: string[][]; children?: Record<string, Order> };
// Bottom first. A name is a file (without .ts) or a folder directly inside the folder the order describes; "*" is
// every name not listed. Files directly inside one folder are one unit (no order between them). A folder without an
// order is one unit too. index.ts is a folder's barrel and sits above everything in it.
const ORDER: Order = {
  tiers: [["config"], ["login"], ["providers"], ["protocol"], ["core"], ["exec", "tui"], ["cli"]],
  children: {
    providers: { tiers: [["images", "sanitize"], ["catalog"], ["search"], ["provider"], ["anthropic", "openai"], ["account"]] },
    core: {
      tiers: [["proc"], ["data"], ["install", "tmux", "prompt"], ["tools"], ["agent-loop"]],
      children: {
        data: { tiers: [["storage-lock"], ["projects"], ["images"], ["inbox"], ["tasks", "transcripts"], ["memory"]] },
        tools: { tiers: [["registry"], ["*"], ["mount"]] },
        "agent-loop": { tiers: [["loop"], ["orc"]] },
      },
    },
    tui: { tiers: [["commands", "history", "components"], ["header", "conversation"], ["footer"], ["screen"], ["app"]] },
  },
};

const SIZE = { sourceLines: 800, testLines: 1500, params: 8, barrelExports: 40 };
// Today's offenders: the number is a ceiling. Growth fails; shrink it here when the file shrinks; delete the row once
// the file is within SIZE (the test fails on a stale row).
const DEBT: Record<string, { lines?: number; exports?: number }> = {
  "tui/app.ts": { lines: 2131 },
  "tui/app.test.ts": { lines: 4253 },
  "protocol/index.ts": { exports: 48 },
};

// ---- the source graph ----

type Name = { name: string; type: boolean };
type Import = {
  from: string; // module id: path under src without .ts, e.g. core/data/tasks/tasks
  to: string;
  spec: string;
  line: number;
  typeOnly: boolean; // `import type`, `export type … from`, or a type-position `import("x").T`
  names: Name[]; // empty for namespace, side-effect and dynamic value imports (the whole module)
  whole: boolean;
  kind: "import" | "export" | "side-effect" | "dynamic" | "import-type";
};
type BarrelEntry = { name: string; module: string; type: boolean; line: number };
type Barrel = { file: string; entries: BarrelEntry[]; impure: string[] };

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) { if (!entry.startsWith("__")) out.push(...walk(path)); }
    else if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}
const files = walk(ROOT).map((f) => f.slice(ROOT.length + 1));
const moduleOf = (file: string) => file.replace(/\.ts$/, "");
const isTest = (file: string) => /\.test\.ts$/.test(file) || file.startsWith("test/");
const isBarrel = (file: string) => basename(file) === "index.ts";
const folderOf = (id: string) => dirname(id) === "." ? "" : dirname(id);
const top = (id: string) => id.split("/")[0]!;
const sources = new Map(files.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));
const asts = new Map(files.map((f) => [f, parse(sources.get(f)!, { sourceType: "module", plugins: ["typescript"], attachComment: false })]));

function resolve(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // a package or node: module
  const base = normalize(join(folderOf(from), spec)).replace(/\/$/, "").replace(/\.ts$/, "");
  const id = base === "." ? "" : base;
  if (id.startsWith("..")) return null; // outside src (package.json, scripts/)
  if (files.includes(id + ".ts")) return id;
  if (files.includes((id ? id + "/" : "") + "index.ts")) return (id ? id + "/" : "") + "index";
  return null;
}

function importsOf(file: string): Import[] {
  const from = moduleOf(file);
  const out: Import[] = [];
  const add = (spec: string, line: number, kind: Import["kind"], typeOnly: boolean, names: Name[], whole: boolean) => {
    const to = resolve(from, spec);
    if (to !== null) out.push({ from, to, spec, line, typeOnly, names, whole, kind });
  };
  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const child of node) visit(child); return; }
    switch (node.type) {
      case "ImportDeclaration": {
        const typeOnly = node.importKind === "type";
        const specs = node.specifiers as any[];
        if (!specs.length) { add(node.source.value, node.loc.start.line, "side-effect", false, [], true); return; }
        const whole = specs.some((s) => s.type === "ImportNamespaceSpecifier" || s.type === "ImportDefaultSpecifier");
        const names = specs.filter((s) => s.type === "ImportSpecifier").map((s) => ({ name: s.imported.name ?? s.imported.value, type: typeOnly || s.importKind === "type" }));
        add(node.source.value, node.loc.start.line, "import", typeOnly || (names.length > 0 && !whole && names.every((n) => n.type)), names, whole);
        return;
      }
      case "ExportNamedDeclaration":
        if (node.source) {
          const typeOnly = node.exportKind === "type";
          const specs = node.specifiers as any[];
          const whole = specs.some((s) => s.type === "ExportNamespaceSpecifier");
          const names = specs.filter((s) => s.type === "ExportSpecifier").map((s) => ({ name: s.local.name, type: typeOnly || s.exportKind === "type" }));
          add(node.source.value, node.loc.start.line, "export", typeOnly || (names.length > 0 && !whole && names.every((n) => n.type)), names, whole);
          return;
        }
        break;
      case "ExportAllDeclaration":
        add(node.source.value, node.loc.start.line, "export", node.exportKind === "type", [], true);
        return;
      case "CallExpression":
        if (node.callee?.type === "Import" && node.arguments[0]?.type === "StringLiteral") add(node.arguments[0].value, node.loc.start.line, "dynamic", false, [], true);
        break;
      case "TSImportType": {
        const arg = node.argument?.type === "TSLiteralType" ? node.argument.literal : node.argument;
        let q = node.qualifier;
        while (q && q.type === "TSQualifiedName") q = q.left;
        if (arg?.type === "StringLiteral") add(arg.value, node.loc.start.line, "import-type", true, q?.type === "Identifier" ? [{ name: q.name, type: true }] : [], !q);
        break;
      }
    }
    for (const key of Object.keys(node)) if (key !== "loc" && key !== "type") visit(node[key]);
  };
  visit(asts.get(file)!.program.body);
  return out;
}

function barrelOf(file: string): Barrel {
  const entries: BarrelEntry[] = [];
  const impure: string[] = [];
  for (const node of asts.get(file)!.program.body as any[]) {
    const line = node.loc.start.line;
    if (node.type === "ExportNamedDeclaration" && node.source) {
      const spec: string = node.source.value;
      if (!/^\.\/[^/]+$/.test(spec) || spec === "./index") impure.push(`${file}:${line} re-exports "${spec}"; a barrel re-exports only files directly in its folder (./name), never a sub-folder, a parent or another barrel`);
      const module = resolve(moduleOf(file), spec) ?? `${folderOf(moduleOf(file))}/${spec.slice(2)}`;
      for (const s of node.specifiers as any[]) {
        if (s.type === "ExportNamespaceSpecifier") entries.push({ name: s.exported.name, module, type: node.exportKind === "type", line });
        else entries.push({ name: s.exported.name ?? s.exported.value, module, type: node.exportKind === "type" || s.exportKind === "type", line });
      }
    } else if (node.type === "ExportAllDeclaration") {
      impure.push(`${file}:${line} uses \`export *\`; list the names (\`export { a, type B } from "${node.source.value}"\`) so the surface is explicit and countable`);
    } else {
      impure.push(`${file}:${line} is a ${node.type}; a barrel holds only \`export { … } from "./file"\` statements (comments are fine)`);
    }
  }
  return { file, entries, impure };
}

const barrels = new Map(files.filter(isBarrel).map((f) => [moduleOf(f), barrelOf(f)]));
const imports = new Map(files.map((f) => [f, importsOf(f)]));

// A file-to-file edge, barrel imports resolved to the files behind the names.
type Edge = { from: string; to: string; line: number; typeOnly: boolean; via: string | null };
function edgesOf(imp: Import): { edges: Edge[]; problems: string[] } {
  const barrel = barrels.get(imp.to);
  if (!barrel) return { edges: [{ from: imp.from, to: imp.to, line: imp.line, typeOnly: imp.typeOnly, via: null }], problems: [] };
  const edges: Edge[] = [];
  const problems: string[] = [];
  if (imp.whole || !imp.names.length) {
    for (const module of new Set(barrel.entries.map((e) => e.module))) edges.push({ from: imp.from, to: module, line: imp.line, typeOnly: imp.typeOnly, via: imp.to });
    return { edges, problems };
  }
  for (const n of imp.names) {
    const entry = barrel.entries.find((e) => e.name === n.name);
    if (!entry) { problems.push(`${imp.from}.ts:${imp.line} imports ${n.name} from "${imp.spec}" but ${barrel.file} does not export it; add it to that barrel`); continue; }
    edges.push({ from: imp.from, to: entry.module, line: imp.line, typeOnly: imp.typeOnly || n.type || entry.type, via: imp.to });
  }
  return { edges, problems };
}

// ---- the order ----

function tierAt(spec: Order, child: string): number {
  const i = spec.tiers.findIndex((t) => t.includes(child));
  if (i >= 0) return i;
  const star = spec.tiers.findIndex((t) => t.includes("*"));
  return star >= 0 ? star : -1;
}
type Kind = "intra" | "down" | "up" | "side" | "unordered";
function classify(a: string, b: string): { kind: Kind; at: string; ca: string; cb: string; spec?: Order } {
  const pa = a.split("/"), pb = b.split("/");
  let i = 0;
  while (i < pa.length - 1 && i < pb.length - 1 && pa[i] === pb[i]) i++;
  const at = pa.slice(0, i).join("/");
  const ca = pa[i]!, cb = pb[i]!;
  if (pa.length - 1 === i && pb.length - 1 === i) return { kind: "intra", at, ca, cb }; // two files in one folder
  let spec: Order | undefined = ORDER;
  for (const seg of pa.slice(0, i)) spec = spec?.children?.[seg];
  if (!spec) return { kind: "intra", at, ca, cb }; // a folder without an order is one unit
  const ta = tierAt(spec, ca), tb = tierAt(spec, cb);
  if (ta < 0 || tb < 0) return { kind: "unordered", at, ca, cb, spec };
  if (ta === tb) return { kind: ca === cb ? "intra" : "side", at, ca, cb, spec };
  return { kind: ta > tb ? "down" : "up", at, ca, cb, spec };
}
const showOrder = (spec: Order) => spec.tiers.map((t) => t.join("·")).join(" < ");

const production = files.filter((f) => !isTest(f));
const resolved = production.filter((f) => !isBarrel(f)).flatMap((f) => imports.get(f)!.map((imp) => ({ imp, ...edgesOf(imp) })));

describe("layout", () => {
  test("every import resolves to what its barrel exports", () => {
    expect(resolved.flatMap((r) => r.problems)).toEqual([]);
  });

  test("(a) packages point down: " + showOrder(ORDER), () => {
    const bad: string[] = [];
    for (const { edges } of resolved) for (const e of edges) {
      if (top(e.from) === top(e.to)) continue;
      const c = classify(e.from, e.to);
      if (c.kind === "down") continue;
      const why = c.kind === "side" ? `${c.ca} and ${c.cb} sit on the same tier and never import each other` : c.kind === "up" ? `${c.cb} is above ${c.ca}` : `${c.ca} or ${c.cb} is not in the package order`;
      bad.push(`${e.from}.ts:${e.line} → ${e.to}.ts${e.typeOnly ? " (type-only)" : ""}: ${why}. Move the shared piece into a lower package or narrow the type in place (see CLAUDE.md Layout).`);
    }
    expect(bad).toEqual([]);
  });

  test("(b) inside a package, folders and files point down in the documented order", () => {
    const bad: string[] = [];
    for (const { edges } of resolved) for (const e of edges) {
      if (top(e.from) !== top(e.to)) continue;
      const c = classify(e.from, e.to);
      if (c.kind === "down" || c.kind === "intra") continue;
      const order = c.spec ? ` The order in src/${c.at} is ${showOrder(c.spec)}.` : "";
      const why = c.kind === "side" ? `${c.ca} and ${c.cb} are on the same tier of src/${c.at}` : c.kind === "up" ? `${c.cb} sits above ${c.ca} in src/${c.at}` : `${c.ca} or ${c.cb} is not in the order for src/${c.at}; add it to ORDER in organization.test.ts and CLAUDE.md`;
      bad.push(`${e.from}.ts:${e.line} → ${e.to}.ts${e.typeOnly ? " (type-only)" : ""}: ${why}.${order} Move the shared piece down or narrow the type in place.`);
    }
    expect(bad).toEqual([]);
  });

  test("(c) non-test code crosses a folder boundary only through that folder's barrel", () => {
    const bad: string[] = [];
    for (const file of production) {
      if (isBarrel(file)) continue;
      const from = moduleOf(file);
      for (const imp of imports.get(file)!) {
        const sameFolder = folderOf(from) === folderOf(imp.to);
        if (sameFolder && isBarrel(imp.to + ".ts")) bad.push(`${file}:${imp.line} imports its own folder's barrel "${imp.spec}" (a cycle); import the file directly`);
        else if (!sameFolder && !isBarrel(imp.to + ".ts")) bad.push(`${file}:${imp.line} imports the deep module "${imp.spec}"; import from its folder's barrel instead (${imp.spec.replace(/\/[^/]+$/, "") || "."}) and add the names to ${folderOf(imp.to)}/index.ts if they are missing`);
        else if (!sameFolder && /\/index$/.test(imp.spec)) bad.push(`${file}:${imp.line} spells the barrel as "${imp.spec}"; use the folder "${imp.spec.replace(/\/index$/, "")}"`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("(d) a barrel holds only named re-exports of its own folder's files", () => {
    const bad: string[] = [];
    for (const b of barrels.values()) {
      bad.push(...b.impure);
      const seen = new Map<string, number>();
      for (const e of b.entries) {
        if (seen.has(e.name)) bad.push(`${b.file}:${e.line} exports ${e.name} twice (first at line ${seen.get(e.name)})`);
        seen.set(e.name, e.line);
        if (!files.includes(e.module + ".ts")) bad.push(`${b.file}:${e.line} re-exports from a file that does not exist: ${e.module}.ts`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("(e) src/ holds only the package folders, test/ and this test", () => {
    const allowed = new Set([...PACKAGES, "test"]);
    const bad: string[] = [];
    for (const entry of readdirSync(ROOT).sort()) {
      const dir = statSync(join(ROOT, entry)).isDirectory();
      if (dir ? allowed.has(entry) : entry === "organization.test.ts") continue;
      bad.push(dir ? `src/${entry}/ is not a package; the packages are ${PACKAGES.join(", ")} (plus test/). Put it inside one or add it to PACKAGES and ORDER here and in CLAUDE.md` : `src/${entry} is a loose file; every module lives in a package folder`);
    }
    expect(bad).toEqual([]);
    for (const p of PACKAGES) expect(statSync(join(ROOT, p)).isDirectory()).toBe(true);
  });

  test("(f) size gates, with DEBT as the ceiling for today's offenders", () => {
    const bad: string[] = [];
    const over = (file: string, what: "lines" | "exports", actual: number, limit: number, fix: string) => {
      const ceiling = DEBT[file]?.[what];
      if (ceiling !== undefined) {
        if (actual <= limit) bad.push(`${file} is within the ${what} gate now (${actual} ≤ ${limit}); delete its ${what} row from DEBT`);
        else if (actual > ceiling) bad.push(`${file} grew to ${actual} ${what}, above its DEBT ceiling of ${ceiling} (gate ${limit}); ${fix}, the ceiling only falls`);
      } else if (actual > limit) bad.push(`${file} has ${actual} ${what}, above the gate of ${limit}; ${fix}`);
    };
    for (const file of files) {
      const src = sources.get(file)!;
      const lines = src.split("\n").length - (src.endsWith("\n") ? 1 : 0);
      over(file, "lines", lines, isTest(file) ? SIZE.testLines : SIZE.sourceLines, "split it by responsibility (a new file below it in the order, or a sub-folder with its own barrel)");
      const visit = (node: any, name: string): void => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) { for (const child of node) visit(child, name); return; }
        const params = node.params ?? node.parameters;
        if (typeof node.type === "string" && /Function|Method|Signature|Constructor/.test(node.type) && Array.isArray(params) && params.length > SIZE.params) {
          bad.push(`${file}:${node.loc.start.line} ${node.id?.name ?? node.key?.name ?? name ?? "(anonymous)"} takes ${params.length} parameters, above the gate of ${SIZE.params}; pass an options object`);
        }
        const inner = node.type === "VariableDeclarator" ? node.id?.name : node.type === "ObjectProperty" || node.type === "ClassProperty" ? node.key?.name : name;
        for (const key of Object.keys(node)) if (key !== "loc" && key !== "type") visit(node[key], inner);
      };
      visit(asts.get(file)!.program.body, "");
    }
    for (const b of barrels.values()) over(b.file, "exports", b.entries.length, SIZE.barrelExports, "the folder exposes too much: split it, or move callers' needs behind fewer entry points");
    for (const file of Object.keys(DEBT)) if (!files.includes(file)) bad.push(`DEBT lists ${file}, which no longer exists; delete the row`);
    expect(bad).toEqual([]);
  });
});
