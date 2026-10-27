#!/usr/bin/env bun
import { migrateLayout } from "../src/config/migrate-layout";
const args = process.argv.slice(2);
function value(flag: string) { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; }
try {
  if (args.some((a, i) => !["--root", "--bin", "--apply", "--offline-acknowledged", "--rollback"].includes(a) && !["--root", "--bin"].includes(args[i - 1] ?? ""))) throw new Error("unknown argument");
  const root = value("--root"), bin = value("--bin");
  if (!root || !bin) throw new Error("usage: bun scripts/migrate-layout.ts --root /absolute/.orca --bin /absolute/.local/bin [--apply --offline-acknowledged] [--rollback]");
  const entries = migrateLayout({ root, bin, apply: args.includes("--apply"), offline: args.includes("--offline-acknowledged"), rollback: args.includes("--rollback") });
  console.log(`${args.includes("--apply") ? "Applied" : "PLAN ONLY (no writes)"}: ${entries.join(", ") || "version marker only"}`);
} catch (error) { console.error(String(error)); process.exitCode = 1; }
