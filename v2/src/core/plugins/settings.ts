import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { fail, ok, parseJson, paths, type Result } from "../../config";
import { writeAtomic } from "../conversations";

const Settings = z.record(z.string(), z.unknown());
const valid = /^[a-z][a-z0-9-]{0,39}$/;
export const SETTINGS_FILE = ".orca-settings.json";

function location(name: string, bubble: string | null): string {
  return join(bubble === null ? paths.globalData : paths.bubbleData(bubble), name, SETTINGS_FILE);
}

async function layer(file: string): Promise<Result<Record<string, unknown>>> {
  const source = Bun.file(file);
  if (!(await source.exists())) return ok({});
  const parsed = parseJson(await source.text());
  if (!parsed.ok) return fail(`invalid settings in ${file}`);
  const settings = Settings.safeParse(parsed.data);
  return settings.success ? ok(settings.data) : fail(`settings in ${file} must be an object`);
}

export async function pluginSettings(name: string, bubble: string | null): Promise<Result<Record<string, unknown>>> {
  if (!valid.test(name)) return fail("invalid plugin name");
  const global = await layer(location(name, null));
  if (!global.ok || bubble === null) return global;
  const scoped = await layer(location(name, bubble));
  return scoped.ok ? ok({ ...global.data, ...scoped.data }) : scoped;
}

export async function setPluginSetting(
  name: string,
  bubble: string | null,
  key: string,
  value: Result<unknown> | null,
): Promise<Result<Record<string, unknown>>> {
  if (!valid.test(name) || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(key) || ["constructor", "prototype"].includes(key))
    return fail("invalid plugin name or setting key");
  if (value !== null && !value.ok) return fail("a setting value must be JSON");
  const file = location(name, bubble),
    current = await layer(file);
  if (!current.ok) return current;
  if (value === null) delete current.data[key];
  else current.data[key] = value.data;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeAtomic(file, JSON.stringify(current.data, null, 2));
  return pluginSettings(name, bubble);
}
