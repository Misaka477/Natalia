import { defineService } from "@anthelia/runtime-services";
import type { CompositionProfile } from "./profile";

/**
 * The resolved composition profile as a tokenized service (rina's
 * shape): provided at boot by the framework wire — re-provided on every
 * config reload, so drop-in edits land on reload — and read by the
 * composition-row consumers (today: the confinement default in the tool
 * pipeline). A profile that failed to load never reaches this token:
 * activation fails fast with the file and the legal values named.
 */
export const compositionProfile = defineService<CompositionProfile>(
  "composition.profile",
  {
    scope: "workspace",
    capability: "services",
  },
);
