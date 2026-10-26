// The layout, enforced: CLAUDE.md "Layout" is the prose, this file is the check. It reads every src/**/*.ts
// import (static, export-from, side-effect, dynamic, `import("x").T` types, directory specifiers) and asserts
//   (a) packages point down: config < login < providers < protocol < core < exec · tui < cli, type-only included;
//   (b) inside a package, folders/files point down in the documented order (ORDER below);
//   (c) code crossing a folder boundary imports that folder's barrel (`../../core/data/tasks`), never a deep module,
//       except that a file of an ancestor folder may be imported directly (`../sanitize`, `../../proc`); intra-folder
//       imports stay direct; a file never imports its own folder's barrel or an ancestor's barrel (`..`), a cycle;
//   (d) a barrel (index.ts) holds nothing but named re-exports of its own folder's files;
//   (e) src/ holds only the package folders, test/ and this file;
//   (f) size gates (SIZE), with DEBT listing today's offenders at their current numbers as ceilings that may only fall.
// Tests (*.test.ts, src/test/) are exempt from (a)–(c): they may import anything, deep or up. (d)–(f) apply to every file.
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
    providers: { tiers: [["images", "sanitize", "retry"], ["catalog"], ["search"], ["provider"], ["anthropic", "openai"], ["account"]] },
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
// Today's offenders: the number is a ceiling. Growth fails; shrink the ceiling here when the file shrinks; delete the
// row once the file is within SIZE (the test fails on a stale row).
const DEBT: Record<string, { lines?: number; exports?: number }> = {
  "tui/app.ts": { lines: 2131 },
  "tui/app.test.ts": { lines: 4253 },
  "protocol/index.ts": { exports: 48 },
};

// ---- the files ----

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
const isBarrelModule = (id: string) => basename(id) === "index";
const folderOf = (id: string) => (dirname(id) === "." ? "" : dirname(id));
const isAncestorFolder = (folder: string, of: string) => folder === "" ? of !== "" : of.startsWith(folder + "/");
const top = (id: string) => id.split("/")[0]!;
const sources = new Map(files.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));
const asts = new Map(files.map((f) => [f, parse(sources.get(f)!, { sourceType: "module", plugins: ["typescript"], attachComment: false })]));

// A relative specifier resolved to a module id (path under src without .ts; a folder resolves to its index), null for
// anything outside src (package.json, scripts/), or an error string when nothing is there.
function resolve(from: string, spec: string): string | null | Error {
  if (!spec.startsWith(".")) return null; // a package or node: module
  const base = normalize(join(folderOf(from), spec)).replace(/\/$/, "").replace(/\.[jt]s$/, "");
  const id = base === "." ? "" : base;
  if (id.startsWith("..")) return null;
  if (files.includes(id + ".ts")) return id;
  const index = (id ? id + "/" : "") + "index";
  if (files.includes(index + ".ts")) return index;
  return new Error(`"${spec}" resolves to nothing under src/ (neither ${id || "."}.ts nor ${index}.ts)`);
}

// ---- the imports ----

type Name = { name: string; type: boolean };
type Import = {
  from: string; // module id, e.g. core/data/tasks/tasks
  to: string;
  spec: string;
  line: number;
  typeOnly: boolean; // `import type`, `export type … from`, or a type-position `import("x").T`
  names: Name[]; // empty for namespace, side-effect and dynamic value imports (the whole module)
  whole: boolean;
};
type Found = { spec: string; line: number; typeOnly: boolean; names: Name[]; whole: boolean };

const specifierName = (s: any): string => s.imported?.name ?? s.imported?.value ?? s.local?.name;
const allTypes = (names: Name[], whole: boolean) => names.length > 0 && !whole && names.every((n) => n.type);

function fromImport(node: any): Found {
  const typeOnly = node.importKind === "type";
  const specs = node.specifiers as any[];
  const whole = specs.length === 0 || specs.some((s) => s.type !== "ImportSpecifier");
  const names = specs.filter((s) => s.type === "ImportSpecifier").map((s) => ({ name: specifierName(s), type: typeOnly || s.importKind === "type" }));
  return { spec: node.source.value, line: node.loc.start.line, typeOnly: typeOnly || allTypes(names, whole), names, whole };
}
function fromExportFrom(node: any): Found {
  const typeOnly = node.exportKind === "type";
  const specs = node.specifiers as any[];
  const whole = specs.some((s) => s.type === "ExportNamespaceSpecifier");
  const names = specs.filter((s) => s.type === "ExportSpecifier").map((s) => ({ name: s.local.name, type: typeOnly || s.exportKind === "type" }));
  return { spec: node.source.value, line: node.loc.start.line, typeOnly: typeOnly || allTypes(names, whole), names, whole };
}
function fromExportAll(node: any): Found {
  return { spec: node.source.value, line: node.loc.start.line, typeOnly: node.exportKind === "type", names: [], whole: true };
}
function fromDynamic(node: any): Found | null {
  if (node.callee?.type !== "Import" || node.arguments[0]?.type !== "StringLiteral") return null;
  return { spec: node.arguments[0].value, line: node.loc.start.line, typeOnly: false, names: [], whole: true };
}
function fromImportType(node: any): Found | null {
  const arg = node.argument?.type === "TSLiteralType" ? node.argument.literal : node.argument;
  if (arg?.type !== "StringLiteral") return null;
  let q = node.qualifier;
  while (q?.type === "TSQualifiedName") q = q.left;
  const names = q?.type === "Identifier" ? [{ name: q.name, type: true }] : [];
  return { spec: arg.value, line: node.loc.start.line, typeOnly: true, names, whole: !q };
}
function foundIn(node: any): Found | null {
  switch (node.type) {
    case "ImportDeclaration": return fromImport(node);
    case "ExportNamedDeclaration": return node.source ? fromExportFrom(node) : null;
    case "ExportAllDeclaration": return fromExportAll(node);
    case "CallExpression": return fromDynamic(node);
    case "TSImportType": return fromImportType(node);
    default: return null;
  }
}
function eachNode(node: any, visit: (node: any) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const child of node) eachNode(child, visit); return; }
  if (typeof node.type === "string") visit(node);
  for (const key of Object.keys(node)) if (key !== "loc" && key !== "type") eachNode(node[key], visit);
}

const unresolved: string[] = [];
function importsOf(file: string): Import[] {
  const from = moduleOf(file);
  const out: Import[] = [];
  eachNode(asts.get(file)!.program.body, (node) => {
    const found = foundIn(node);
    if (!found) return;
    const to = resolve(from, found.spec);
    if (to instanceof Error) unresolved.push(`${file}:${found.line} ${to.message}`);
    else if (to !== null) out.push({ from, to, ...found });
  });
  return out;
}

// ---- the barrels ----

type BarrelEntry = { name: string; module: string; type: boolean; line: number };
type Barrel = { file: string; entries: BarrelEntry[]; impure: string[] };

function barrelSource(barrel: string, node: any): { module: string; impure: string | null } {
  const spec: string = node.source.value;
  const line = node.loc.start.line;
  const fallback = `${folderOf(moduleOf(barrel))}/${spec.slice(2)}`;
  const resolved = resolve(moduleOf(barrel), spec);
  const module = typeof resolved === "string" ? resolved : fallback;
  if (!/^\.\/[^/]+$/.test(spec) || spec === "./index") return { module, impure: `${barrel}:${line} re-exports "${spec}"; a barrel re-exports only files directly in its folder (./name), never a sub-folder, a parent or another barrel` };
  if (isBarrelModule(module)) return { module, impure: `${barrel}:${line} re-exports the sub-folder barrel "${spec}"; a barrel covers only the files directly in its folder — callers import ${module.replace(/\/index$/, "")} themselves` };
  return { module, impure: null };
}
function barrelEntries(node: any, module: string): BarrelEntry[] {
  const line = node.loc.start.line;
  return (node.specifiers as any[]).map((s) => ({
    name: s.exported.name ?? s.exported.value,
    module,
    type: node.exportKind === "type" || (s.type === "ExportSpecifier" && s.exportKind === "type"),
    line,
  }));
}
function barrelOf(file: string): Barrel {
  const entries: BarrelEntry[] = [];
  const impure: string[] = [];
  for (const node of asts.get(file)!.program.body as any[]) {
    const line = node.loc.start.line;
    if (node.type === "ExportNamedDeclaration" && node.source) {
      const { module, impure: problem } = barrelSource(file, node);
      if (problem) impure.push(problem);
      entries.push(...barrelEntries(node, module));
    } else if (node.type === "ExportAllDeclaration") {
      impure.push(`${file}:${line} uses \`export *\`; list the names (\`export { a, type B } from "${node.source.value}"\`) so the surface is explicit and countable`);
    } else {
      impure.push(`${file}:${line} is a ${node.type}; a barrel holds only \`export { … } from "./file"\` statements (comments are fine)`);
    }
  }
  return { file, entries, impure };
}

function barrelProblems(b: Barrel): string[] {
  const out = [...b.impure];
  const seen = new Map<string, number>();
  for (const e of b.entries) {
    if (seen.has(e.name)) out.push(`${b.file}:${e.line} exports ${e.name} twice (first at line ${seen.get(e.name)})`);
    seen.set(e.name, e.line);
    if (!files.includes(e.module + ".ts")) out.push(`${b.file}:${e.line} re-exports from a file that does not exist: ${e.module}.ts`);
  }
  return out;
}

const barrels = new Map(files.filter(isBarrel).map((f) => [moduleOf(f), barrelOf(f)]));
const imports = new Map(files.map((f) => [f, importsOf(f)]));

// A file-to-file edge, barrel imports resolved to the files behind the names.
type Edge = { from: string; to: string; line: number; typeOnly: boolean };
function edgesOf(imp: Import): { edges: Edge[]; problems: string[] } {
  const barrel = barrels.get(imp.to);
  if (!barrel) return { edges: [{ from: imp.from, to: imp.to, line: imp.line, typeOnly: imp.typeOnly }], problems: [] };
  if (imp.whole || !imp.names.length) {
    const modules = [...new Set(barrel.entries.map((e) => e.module))];
    return { edges: modules.map((to) => ({ from: imp.from, to, line: imp.line, typeOnly: imp.typeOnly })), problems: [] };
  }
  const edges: Edge[] = [];
  const problems: string[] = [];
  for (const n of imp.names) {
    const entry = barrel.entries.find((e) => e.name === n.name);
    if (entry) edges.push({ from: imp.from, to: entry.module, line: imp.line, typeOnly: imp.typeOnly || n.type || entry.type });
    else problems.push(`${imp.from}.ts:${imp.line} imports ${n.name} from "${imp.spec}" but ${barrel.file} does not export it; add it to that barrel`);
  }
  return { edges, problems };
}

// ---- the order ----

type Kind = "intra" | "down" | "up" | "side" | "unordered";
type Classified = { kind: Kind; at: string; ca: string; cb: string; spec?: Order };

function tierAt(spec: Order, child: string): number {
  const i = spec.tiers.findIndex((t) => t.includes(child));
  return i >= 0 ? i : spec.tiers.findIndex((t) => t.includes("*"));
}
function orderAt(path: string[]): Order | undefined {
  let spec: Order | undefined = ORDER;
  for (const seg of path) spec = spec?.children?.[seg];
  return spec;
}
function kindOf(spec: Order, ca: string, cb: string): Kind {
  const ta = tierAt(spec, ca), tb = tierAt(spec, cb);
  if (ta < 0 || tb < 0) return "unordered";
  if (ta === tb) return ca === cb ? "intra" : "side";
  return ta > tb ? "down" : "up";
}
function classify(a: string, b: string): Classified {
  const pa = a.split("/"), pb = b.split("/");
  let i = 0;
  while (i < pa.length - 1 && i < pb.length - 1 && pa[i] === pb[i]) i++;
  const at = pa.slice(0, i).join("/");
  const ca = pa[i]!, cb = pb[i]!;
  if (pa.length - 1 === i && pb.length - 1 === i) return { kind: "intra", at, ca, cb }; // two files in one folder
  const spec = orderAt(pa.slice(0, i));
  if (!spec) return { kind: "intra", at, ca, cb }; // a folder without an order is one unit
  return { kind: kindOf(spec, ca, cb), at, ca, cb, spec };
}
const showOrder = (spec: Order) => spec.tiers.map((t) => t.join("·")).join(" < ");

// The message for an edge that does not point down.
function explain(e: Edge, c: Classified): string {
  const where = c.at ? `src/${c.at}` : "the packages";
  const why = {
    side: `${c.ca} and ${c.cb} sit on the same tier of ${where} and never import each other`,
    up: `${c.cb} sits above ${c.ca} in ${where}`,
    unordered: `${c.ca} or ${c.cb} is not in the order for ${where}; add it to ORDER in organization.test.ts and CLAUDE.md`,
  }[c.kind as "side" | "up" | "unordered"];
  const order = c.spec ? ` The order in ${where} is ${showOrder(c.spec)}.` : "";
  const type = e.typeOnly ? " (type-only)" : "";
  return `${e.from}.ts:${e.line} → ${e.to}.ts${type}: ${why}.${order} Move the shared piece down or narrow the type in place (see CLAUDE.md Layout).`;
}
function orderProblems(edges: Edge[], across: boolean): string[] {
  const out: string[] = [];
  for (const e of edges) {
    if ((top(e.from) !== top(e.to)) !== across) continue;
    const c = classify(e.from, e.to);
    if (c.kind !== "down" && c.kind !== "intra") out.push(explain(e, c));
  }
  return out;
}

// (c) for one import of a non-test, non-barrel file; null when it is fine.
function crossingProblem(file: string, imp: Import): string | null {
  const here = folderOf(moduleOf(file)), there = folderOf(imp.to);
  const barrel = isBarrelModule(imp.to);
  const folder = imp.spec.replace(/\/[^/]+$/, "") || ".";
  if (here === there) return barrel ? `${file}:${imp.line} imports its own folder's barrel "${imp.spec}" (a cycle); import the file directly` : null;
  if (isAncestorFolder(there, here)) return barrel ? `${file}:${imp.line} imports an ancestor folder's barrel "${imp.spec}" (a cycle: that barrel reaches back into this folder); import the file itself (${imp.spec.replace(/\/?$/, "")}/<file>)` : null;
  if (!barrel) return `${file}:${imp.line} imports the deep module "${imp.spec}"; import from its folder's barrel instead (${folder}) and add the names to ${there}/index.ts if they are missing`;
  if (/\/index(\.[jt]s)?$/.test(imp.spec)) return `${file}:${imp.line} spells the barrel as "${imp.spec}"; use the folder "${folder}"`;
  return null;
}

// (f) helpers.
type Gate = "lines" | "exports";
function sizeProblem(file: string, what: Gate, actual: number, limit: number, fix: string): string | null {
  const ceiling = DEBT[file]?.[what];
  if (ceiling === undefined) return actual > limit ? `${file} has ${actual} ${what}, above the gate of ${limit}; ${fix}` : null;
  if (actual <= limit) return `${file} is within the ${what} gate now (${actual} ≤ ${limit}); delete its ${what} row from DEBT`;
  if (actual > ceiling) return `${file} grew to ${actual} ${what}, above its DEBT ceiling of ${ceiling} (gate ${limit}); ${fix}, the ceiling only falls`;
  return null;
}
const lineCount = (src: string) => src.split("\n").length - (src.endsWith("\n") ? 1 : 0);
const isFunctionLike = (node: any) => /Function|Method|Signature|Constructor/.test(node.type) && Array.isArray(node.params ?? node.parameters);
const ASSIGNS = new Set(["VariableDeclarator", "ObjectProperty", "ClassProperty"]);
const ownName = (node: any): string | undefined => node.id?.name ?? node.key?.name;
function paramProblems(file: string): string[] {
  const out: string[] = [];
  const assigned = new Map<any, string>(); // the name a function was assigned to, for arrows and expressions
  eachNode(asts.get(file)!.program.body, (node) => {
    if (ASSIGNS.has(node.type)) assigned.set(node.init ?? node.value, ownName(node) ?? "(anonymous)");
    if (!isFunctionLike(node)) return;
    const count = (node.params ?? node.parameters).length;
    const name = ownName(node) ?? assigned.get(node) ?? "(anonymous)";
    if (count > SIZE.params) out.push(`${file}:${node.loc.start.line} ${name} takes ${count} parameters, above the gate of ${SIZE.params}; pass an options object`);
  });
  return out;
}
function rootProblem(entry: string): string | null {
  const dir = statSync(join(ROOT, entry)).isDirectory();
  if (dir) return PACKAGES.includes(entry) || entry === "test" ? null : `src/${entry}/ is not a package; the packages are ${PACKAGES.join(", ")} (plus test/). Put it inside one or add it to PACKAGES and ORDER here and in CLAUDE.md`;
  return entry === "organization.test.ts" ? null : `src/${entry} is a loose file; every module lives in a package folder`;
}

const production = files.filter((f) => !isTest(f) && !isBarrel(f));
const resolved = production.flatMap((f) => imports.get(f)!.map(edgesOf));
const edges = resolved.flatMap((r) => r.edges);

describe("layout", () => {
  test("every relative import resolves, and to what its barrel exports", () => {
    expect([...unresolved, ...resolved.flatMap((r) => r.problems)]).toEqual([]);
  });

  test("(a) packages point down: " + showOrder(ORDER), () => {
    expect(orderProblems(edges, true)).toEqual([]);
  });

  test("(b) inside a package, folders and files point down in the documented order", () => {
    expect(orderProblems(edges, false)).toEqual([]);
  });

  test("(c) non-test code crosses a folder boundary only through that folder's barrel", () => {
    const bad = production.flatMap((file) => imports.get(file)!.map((imp) => crossingProblem(file, imp)).filter((p) => p !== null));
    expect(bad).toEqual([]);
  });

  test("(d) a barrel holds only named re-exports of its own folder's files", () => {
    expect([...barrels.values()].flatMap(barrelProblems)).toEqual([]);
  });

  test("(e) src/ holds only the package folders, test/ and this test", () => {
    expect(readdirSync(ROOT).sort().map(rootProblem).filter((p) => p !== null)).toEqual([]);
    for (const p of PACKAGES) expect(statSync(join(ROOT, p)).isDirectory()).toBe(true);
  });

  test("(f) size gates, with DEBT as the ceiling for today's offenders", () => {
    const split = "split it by responsibility (a new file below it in the order, or a sub-folder with its own barrel)";
    const bad = files.flatMap((file) => [
      sizeProblem(file, "lines", lineCount(sources.get(file)!), isTest(file) ? SIZE.testLines : SIZE.sourceLines, split),
      ...paramProblems(file),
    ]);
    for (const b of barrels.values()) bad.push(sizeProblem(b.file, "exports", b.entries.length, SIZE.barrelExports, "the folder exposes too much: split it, or move callers' needs behind fewer entry points"));
    for (const file of Object.keys(DEBT)) if (!files.includes(file)) bad.push(`DEBT lists ${file}, which no longer exists; delete the row`);
    expect(bad.filter((p) => p !== null)).toEqual([]);
  });
});
