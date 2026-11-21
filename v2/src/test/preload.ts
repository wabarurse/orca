import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ORCA2_HOME = mkdtempSync(join(tmpdir(), "orca2-test-home-"));
delete process.env.ORCA2_SCRIPTED;
delete process.env.ORCA2_SELF;
