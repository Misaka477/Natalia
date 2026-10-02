import type { CompactionService } from "@anthelia/runtime";
import { defineService } from "@anthelia/runtime-services";

/** The compaction service token; lives with the mechanism that implements it. */
export const compactionService = defineService<CompactionService>(
  "compaction.service",
  { scope: "workspace", capability: "services" },
);
