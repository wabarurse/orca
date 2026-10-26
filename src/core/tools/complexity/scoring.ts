// Cyclomatic and cognitive complexity for JavaScript and TypeScript, per
// function, from a Babel AST.
//
// Cyclomatic: 1 per function plus one for every decision point (if, loops,
// case, catch, ?:, &&, ||, ??). Nested functions are scored on their own.
//
// Cognitive follows Sonar's definition: +1 for each control-flow structure,
// plus the nesting depth it sits at; else/else-if +1 with no nesting penalty;
// +1 per run of one logical operator (a change of operator starts a new run);
// +1 for recursion; nested functions add a level of nesting and count toward
// the enclosing function.

import { parse } from "@babel/parser";

export interface FunctionScore {
  name: string;
  line: number;
  cyclomatic: number;
  cognitive: number;
}

type Node = { type: string; [key: string]: unknown; loc?: { start: { line: number } } };

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod", "ClassPrivateMethod"]);
const NESTING_TYPES = new Set(["IfStatement", "ConditionalExpression", "SwitchStatement", "ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement", "CatchClause"]);
const LOGICAL = new Set(["&&", "||", "??"]);

const isNode = (v: unknown): v is Node => !!v && typeof v === "object" && typeof (v as Node).type === "string";

function* children(node: Node): Generator<Node> {
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
    if (Array.isArray(value)) { for (const v of value) if (isNode(v)) yield v; }
    else if (isNode(value)) yield value;
  }
}

/** A readable name for a function node, from its own id or where it is assigned. */
function nameOf(node: Node, parent: Node | undefined): string {
  const id = node.id as Node | undefined;
  if (id?.type === "Identifier") return String(id.name);
  const key = node.key as Node | undefined;
  if (key?.type === "Identifier") return String(key.name);
  if (key?.type === "StringLiteral") return String(key.value);
  if (parent?.type === "VariableDeclarator" && isNode(parent.id) && parent.id.type === "Identifier") return String(parent.id.name);
  if (parent?.type === "AssignmentExpression" && isNode(parent.left)) return exprName(parent.left);
  if ((parent?.type === "ObjectProperty" || parent?.type === "ClassProperty") && isNode(parent.key) && parent.key.type === "Identifier") return String(parent.key.name);
  return "<anonymous>";
}

function exprName(node: Node): string {
  if (node.type === "Identifier") return String(node.name);
  if (node.type === "MemberExpression" && isNode(node.object) && isNode(node.property)) return `${exprName(node.object)}.${exprName(node.property)}`;
  return "<anonymous>";
}

function cyclomatic(fn: Node): number {
  let n = 1;
  const visit = (node: Node) => {
    switch (node.type) {
      case "IfStatement": case "ConditionalExpression": case "ForStatement": case "ForInStatement": case "ForOfStatement":
      case "WhileStatement": case "DoWhileStatement": case "CatchClause":
        n++; break;
      case "SwitchCase": if (node.test) n++; break;
      case "LogicalExpression": if (LOGICAL.has(String(node.operator))) n++; break;
    }
    for (const child of children(node)) if (!FUNCTION_TYPES.has(child.type)) visit(child);
  };
  for (const child of children(fn)) visit(child);
  return n;
}

function cognitive(fn: Node, name: string): number {
  let total = 0;
  const visit = (node: Node, nesting: number, parent?: Node) => {
    let childNesting = nesting;
    switch (node.type) {
      case "IfStatement":
        // `else if` is the IfStatement in the parent's alternate: +1, no nesting penalty.
        if (parent?.type === "IfStatement" && parent.alternate === node) total += 1;
        else { total += 1 + nesting; childNesting = nesting + 1; }
        if (node.alternate && isNode(node.alternate) && node.alternate.type !== "IfStatement") total += 1; // a plain else
        break;
      case "ConditionalExpression": case "SwitchStatement": case "ForStatement": case "ForInStatement": case "ForOfStatement":
      case "WhileStatement": case "DoWhileStatement": case "CatchClause":
        total += 1 + nesting;
        childNesting = nesting + 1;
        break;
      case "BreakStatement": case "ContinueStatement":
        if (node.label) total += 1;
        break;
      case "LogicalExpression": {
        // Count each run of one operator once; `a && b && c` is 1, `a && b || c` is 2.
        const op = String(node.operator);
        if (LOGICAL.has(op) && !(parent?.type === "LogicalExpression" && parent.operator === op)) total += 1;
        break;
      }
      case "CallExpression":
        if (isNode(node.callee) && node.callee.type === "Identifier" && node.callee.name === name) total += 1;
        break;
    }
    if (FUNCTION_TYPES.has(node.type) && node !== fn) childNesting = nesting + 1;
    for (const child of children(node)) {
      if (node.type === "IfStatement" && child === node.alternate && child.type === "IfStatement") visit(child, nesting, node);
      else visit(child, childNesting, node);
    }
  };
  for (const child of children(fn)) visit(child, 0, fn);
  return total;
}

/** Score every function in a JavaScript or TypeScript source. */
export function scoreSource(source: string, filename = "file.ts"): FunctionScore[] {
  const ast = parse(source, {
    sourceType: "unambiguous",
    plugins: [...(/\.[cm]?tsx?$/.test(filename) ? ["typescript" as const] : []), ...(/\.[cm]?ts$/.test(filename) ? [] : ["jsx" as const]), "decorators-legacy" as const],
    errorRecovery: true,
    attachComment: false,
  }) as unknown as Node;
  const out: FunctionScore[] = [];
  const walk = (node: Node, parent?: Node) => {
    if (FUNCTION_TYPES.has(node.type)) {
      const name = nameOf(node, parent);
      out.push({ name, line: node.loc?.start.line ?? 0, cyclomatic: cyclomatic(node), cognitive: cognitive(node, name) });
    }
    for (const child of children(node)) walk(child, node);
  };
  walk(ast);
  return out;
}

export const SCORED_EXTENSIONS = /\.(m?[jt]sx?|cjs|cts)$/;

/** A markdown table of the scores, flagging those over the thresholds. */
export function formatScores(rows: (FunctionScore & { file: string })[], limits: { cyclomatic: number; cognitive: number }): string {
  if (!rows.length) return "no functions found";
  const over = (r: FunctionScore) => r.cyclomatic > limits.cyclomatic || r.cognitive > limits.cognitive;
  const lines = ["| file | function | line | cyclomatic | cognitive | |", "|---|---|---|---|---|---|"];
  for (const r of rows.sort((a, b) => Math.max(b.cyclomatic - limits.cyclomatic, b.cognitive - limits.cognitive) - Math.max(a.cyclomatic - limits.cyclomatic, a.cognitive - limits.cognitive))) {
    lines.push(`| ${r.file} | ${r.name} | ${r.line} | ${r.cyclomatic} | ${r.cognitive} | ${over(r) ? "over" : ""} |`);
  }
  const flagged = rows.filter(over).length;
  lines.push("", `${rows.length} functions, ${flagged} over the thresholds (cyclomatic > ${limits.cyclomatic}, cognitive > ${limits.cognitive})`);
  return lines.join("\n");
}
