# orca2 (v2)

The v2 harness: a small core plus plugins. Read `README.md` here first. Bun + TypeScript; use `bun` for everything
(`bun test`, `bun run check`, `bun run lint`, `bun src/cli/main.ts`), run from `v2/`.

Rules:
- v2 imports nothing outside `v2/` (`src/independence.test.ts`). v1 (`../src`) keeps working unchanged.
- Home is `~/.orca2`; tests always get a temporary `ORCA2_HOME` (the preload). Never touch the real home in tests.
- Types: required fields with `null`, empty lists or unions, not optional `?` fields, in new code.
- Layers point down: config < api < core < tui · cli; built-in plugins (`src/plugins`) import core, core never
  imports them (the CLI registers them).
- Keep tool descriptions and role prompts stable (the prompt cache depends on them); plugin prompt lines too.
- A new slot or hook goes into `src/core/plugins/types.ts`, the `orca-plugin` skill and the example plugin together.
