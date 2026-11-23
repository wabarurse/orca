import type { LoadedPlugin, PluginProblem } from "../core/plugins";
import type { Row, Section, Tab } from "../core/plugins/types";

export type PluginPages = Map<string, Tab[]>;
const PROBLEM = "problem:";

const pageLabel = (tab: Tab): string => `${tab.title}${tab.chord === null ? "" : ` (Ctrl+${tab.chord.toUpperCase()})`}`;

export function pluginRows(plugins: Map<string, LoadedPlugin>, problems: PluginProblem[], enabled: string[], pages: PluginPages): Row[] {
  const rows = [...plugins.keys()].sort().map((name): Row => {
    const on = enabled.includes(name);
    const tabs = pages.get(name) ?? [];
    return { id: name, name, status: on ? "on" : "off", info: !on ? "t turns it on" : tabs.length === 0 ? "no page" : tabs.map(pageLabel).join(" · "), tone: on ? "good" : "dim" };
  });
  return [...rows, ...problems.map((p): Row => ({ id: `${PROBLEM}${p.name}`, name: p.name, status: "broken", info: p.problem, tone: "bad" }))];
}

export const isProblem = (row: Row | undefined): boolean => row !== undefined && row.id.startsWith(PROBLEM);

export function pluginDetails(plugins: Map<string, LoadedPlugin>, problems: PluginProblem[], enabled: string[], pages: PluginPages, row: Row): Section[] {
  if (isProblem(row)) {
    const problem = problems.find(p => `${PROBLEM}${p.name}` === row.id);
    return problem === undefined ? [] : [{ title: "Does not load", lines: [problem.problem, problem.dir] }];
  }
  const loaded = plugins.get(row.id);
  if (loaded === undefined) return [];
  const p = loaded.plugin, on = enabled.includes(p.name), tabs = pages.get(p.name) ?? [];
  return [
    { title: p.name, lines: [p.description, `${on ? "on" : "off"} for this bubble · ${loaded.source} · ${loaded.dir}`] },
    { title: "Pages", lines: !on ? ["turn it on (t) to see its pages"] : tabs.length === 0 ? ["none: it adds tools or background work only"] : [...tabs.map(pageLabel), "enter opens it"] },
    ...(p.tools.length === 0 ? [] : [{ title: "Tools", lines: p.tools.map(t => `${t.tool.spec.name} (${t.roles.join(", ")})`) }]),
    ...(p.storage.length === 0 ? [] : [{ title: "Storage", lines: p.storage.map(s => `${s.scope}: ${s.about}`) }]),
    ...(p.retention.length === 0 ? [] : [{ title: "Retention", lines: p.retention.map(r => `${r.tab}: archived ${r.archiveAfterDays === null ? "by hand" : `${r.archiveAfterDays} day${r.archiveAfterDays === 1 ? "" : "s"} after it settles`}, removed by orca2 clean ${r.purgeAfterDays} days later`) }]),
  ];
}
