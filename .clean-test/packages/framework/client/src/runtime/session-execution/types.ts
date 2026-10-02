/**
 * The surface options shared by the session/event runtime surfaces. Declared
 * here (instead of importing the client-surface copy) so the runtime feature
 * stays self-contained; the shape is structurally identical to
 * the runtime client options consumed by this feature.
 */
import type { EpisodeID } from "@anthelia/contracts";

export type ClientSurfaceOptions = {
  episodeID?: EpisodeID;
  globalConfigPath?: string;
};
