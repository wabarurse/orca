# orca2 (v2)

The v2 harness: a small core plus plugins. Read `README.md` here first. Bun + TypeScript; use `bun` for everything
(`bun test`, `bun run check`, `bun run lint`, `bun src/cli/main.ts`), run from `v2/`.

Rules:
- v2 imports nothing outside `v2/` (`src/independence.test.ts`). v1 (`../src`) keeps working unchanged.
- Home is `~/.orca2`; tests always get a temporary `ORCA2_HOME` (the preload). Never touch the real home in tests.
- Types: required fields with `null`, empty lists or unions, not optional `?` fields, in new code.
- TypeScript: no `any`, `as` casts or `!`; `type`, never `interface`; outside data is parsed with Zod; explicit checks
  (`count > 0`, `x !== null`), never truthiness; every promise awaited or handled; no comments. Expected failures return
  the one `Result` (`src/config/result.ts`: `ok`/`fail`) instead of throwing. The gate is
  `tsc --noEmit && eslint . --max-warnings 0 && bun test`.
- Layers point down: config < api < core < tui · cli. No plugin lives in this repository: plugins are the user's,
  in `~/.orca2/plugins/`, and import orca2 only through `orca2/plugin` (`src/core/plugins/api.ts`, provided at load
  by `src/core/plugins/modules.ts`). What a plugin needs from the core is exported there.
- Keep tool descriptions and role prompts stable (the prompt cache depends on them); plugin prompt lines too.
- A new slot or hook goes into `src/core/plugins/types.ts`, the `orca-plugin` skill and the example plugin
  (`src/test/plugins/example`, a test fixture) together.
