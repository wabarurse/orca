import { z } from "zod";
import type { Role } from "./types";

export const RoleRecord = z.enum(["orchestrator", "worker", "reviewer"]).transform((role): Role => role === "reviewer" ? "worker" : role);
