import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createVerification, closeVerification, listVerifications, readVerification, verificationLock, verificationPaths, launchProcess } from "../data/processes";
import { execution } from "../data/projects/lifecycle";
import { cliCommand, sessionId } from "../tmux";
import type { Tool } from "./registry";

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
export const sandbox: Tool = {
  spec: { name: "sandbox", description: "Own a disposable reproduction/verification environment and its cleanup. create snapshots the current directory, including Git edits when available. Ordinary directory copies exclude links, dependencies and caches (256 MiB/20,000 entries); install dependencies in the session. backend=docker uses an already installed image with sh, isolated workspace and evidence mounts, 2 CPUs/2 GiB, and optional localhost-only ports. backend=local supports native tools and optional private iOS simulator deviceType/runtime. run starts a supervised command in the session (completion event, no polling); ORCA_ARTIFACTS is the retained evidence directory. Use installed Playwright/agent-browser, desktop automation, curl, test runners or platform CLIs to interact and save screenshots, videos and API results there. capture takes a local desktop/iOS screenshot or a finite video, or runs your explicit capture command with ORCA_CAPTURE_PATH. Local capture requires OS permissions. Start native apps by their foreground executable so their process group is supervised. close stops owned processes, removes the owned container/private simulator and disposable checkout, and retains evidence under the owning workspace session for archive and explicit orca clean --apply. Sessions expire after 60 minutes by default. Only create resources inside the session. Skills define the platform workflow; successful commands alone do not establish verification.",
    input_schema: { type: "object", properties: {
      action: { type: "string", enum: ["create", "run", "capture", "status", "list", "close"] },
      id: { type: "string" }, backend: { type: "string", enum: ["local", "docker"] }, image: { type: "string" },
      ports: { type: "array", maxItems: 8, items: { type: "integer", minimum: 1, maximum: 65535 } },
      simulator: { type: "object", properties: { deviceType: { type: "string" }, runtime: { type: "string" } }, required: ["deviceType", "runtime"] },
      ttl_minutes: { type: "integer", minimum: 1, maximum: 360 },
      command: { type: "string" }, target: { type: "string", enum: ["desktop", "ios"] },
      filename: { type: "string", description: "capture: evidence basename, e.g. repro.png or verified.mov." },
      seconds: { type: "integer", minimum: 1, maximum: 120, description: "capture: finite video duration; omit for screenshot." },
    }, required: ["action"] } },
  async run(input, ctx) {
    const owner = sessionId(ctx.role, ctx.branch), epoch = ctx.executionEpoch ?? execution.epoch(ctx.project);
    if (input.action === "list") return JSON.stringify((await listVerifications(ctx.project)).filter(v => ctx.role === "orchestrator" || v.owner === owner));
    execution.assertActive(ctx.project, epoch);
    if (input.action === "create") {
      if (input.backend !== "local" && input.backend !== "docker") throw new Error("create requires backend local or docker");
      const ttl = input.ttl_minutes ?? 60;
      if (!Number.isInteger(ttl) || Number(ttl) < 1 || Number(ttl) > 360) throw new Error("ttl_minutes must be 1–360");
      const ports = input.ports ?? [];
      if (!Array.isArray(ports) || ports.length > 8 || ports.some(p => !Number.isInteger(p) || p < 1 || p > 65535)) throw new Error("invalid ports");
      const simulator = input.simulator as { deviceType: string; runtime: string } | undefined;
      if (simulator && (typeof simulator.deviceType !== "string" || typeof simulator.runtime !== "string" || simulator.deviceType.startsWith("-") || simulator.runtime.startsWith("-"))) throw new Error("simulator requires deviceType and runtime");
      const v = await createVerification({ project: ctx.project, epoch, owner, run: ctx.run, ownerPid: process.pid, source: ctx.cwd,
        backend: input.backend, image: typeof input.image === "string" ? input.image : undefined, ports, simulator,
        expiresAt: new Date(Date.now() + Number(ttl) * 60_000).toISOString() }, ctx.signal);
      return JSON.stringify({ ...v, ...verificationPaths(ctx.project, v.id) });
    }
    if (typeof input.id !== "string") throw new Error("session id is required");
    const v = await readVerification(ctx.project, input.id);
    if (ctx.role !== "orchestrator" && (v.owner !== owner || v.run !== ctx.run)) throw new Error("verification belongs to another agent run");
    if (input.action === "close") {
      const closed = await closeVerification(ctx.project, v.id);
      if (closed.state !== "closed") throw new Error(`verification ${v.id} cleanup incomplete: ${closed.errors?.join("; ")}`);
      return JSON.stringify(closed);
    }
    if (input.action === "status") {
      const paths = verificationPaths(ctx.project, v.id), names = await readdir(paths.evidence).catch(() => []);
      const artifacts = await Promise.all(names.sort().slice(0, 30).map(async name => ({ path: join(paths.evidence, name), bytes: (await stat(join(paths.evidence, name))).size })));
      return JSON.stringify({ ...v, ...paths, artifacts });
    }
    if (input.action !== "run" && input.action !== "capture") throw new Error("unknown verification action");
    return verificationLock(ctx.project, v.id, async () => {
      const current = await readVerification(ctx.project, v.id);
      if (current.state !== "active" || Date.parse(current.expiresAt) <= Date.now() || execution.stale(ctx.project, current.epoch)) throw new Error("verification session is no longer active");
      const paths = verificationPaths(ctx.project, v.id);
      let command = input.command;
      const temporary = v.backend === "docker" ? "/tmp" : join(paths.workspace, ".orca-tmp");
      const environment = [`TMPDIR=${quote(temporary)}`, `TMP=${quote(temporary)}`, `TEMP=${quote(temporary)}`, `XDG_CACHE_HOME=${quote(`${temporary}/cache`)}`, `ORCA_ARTIFACTS=${quote(v.backend === "docker" ? "/artifacts" : paths.evidence)}`];
      if (v.simulator?.device) environment.push(`ORCA_SIMULATOR=${quote(v.simulator.device)}`, `ORCA_DEVICE_SET=${quote(paths.devices)}`);
      if (input.action === "capture") {
        if (typeof input.filename !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(input.filename)) throw new Error("capture requires a simple evidence filename");
        const output = v.backend === "docker" ? `/artifacts/${input.filename}` : join(paths.evidence, input.filename);
        environment.push(`ORCA_CAPTURE_PATH=${quote(output)}`);
        const seconds = input.seconds;
        if (seconds !== undefined && (!Number.isInteger(seconds) || Number(seconds) < 1 || Number(seconds) > 120)) throw new Error("seconds must be 1–120");
        if (command === undefined) {
          if (v.backend !== "local" || process.platform !== "darwin") throw new Error("provide a capture command using the platform tooling in this environment");
          if (input.target === "desktop") command = `/usr/sbin/screencapture -x ${seconds ? `-v -V ${seconds} ` : ""}${quote(output)}`;
          else if (input.target === "ios" && v.simulator?.device) {
            const base = `xcrun simctl --set ${quote(paths.devices)} io ${quote(v.simulator.device)}`;
            command = seconds ? `${base} recordVideo ${quote(output)} & recorder=$!; trap 'kill -INT "$recorder" 2>/dev/null' EXIT; sleep ${seconds}; kill -INT "$recorder"; wait "$recorder"; trap - EXIT` : `${base} screenshot ${quote(output)}`;
          } else throw new Error("capture requires desktop, an owned iOS simulator, or an explicit command");
        }
      }
      if (typeof command !== "string" || !command.trim()) throw new Error("command is required");
      const script = `export ${environment.join(" ")}\n${command}`;
      const launchedCommand = v.backend === "docker" ? `docker exec ${quote(`orca-verify-${v.id}`)} sh -c ${quote(script)}` : script;
      const at = new Date().toISOString();
      return JSON.stringify(await launchProcess({ id: crypto.randomUUID(), project: ctx.project, owner, role: ctx.role, branch: ctx.branch,
        run: ctx.run, call: ctx.callId, verification: v.id, artifact: input.action === "capture" ? join(paths.evidence, String(input.filename)) : undefined, recording: input.action === "capture" && input.seconds !== undefined, cwd: paths.workspace, command: launchedCommand, state: "starting", createdAt: at, updatedAt: at,
        timeoutMs: 10 * 60_000, maxBytes: 8 * 1024 * 1024, notify: true, events: [] }, cliCommand(), 0, ctx.signal, epoch));
    });
  },
};
