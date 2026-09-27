import { createHash } from "node:crypto";
import type { RuntimeStructuredDiff } from "@anthelia/contracts";
import type { ObjectStore } from "./object-store";

type StructuredDiffCacheEntry = {
  oldSha256: string;
  newSha256: string;
  additions: number;
  deletions: number;
  structured: RuntimeStructuredDiff;
};

/**
 * Persistent structured-diff cache layered on the object store.
 *
 * The object store already deduplicates file content; this cache prevents
 * recomputing tree-sitter/line diff for the same old/new pair across
 * checkpoint and sandbox operations.
 */
export class DiffCache {
  private readonly seenOrder: string[] = [];
  private readonly seen = new Set<string>();
  private readonly maxEntries: number;

  constructor(
    private readonly objects: ObjectStore,
    private readonly namespace: string,
    maxEntries = 5000,
  ) {
    this.maxEntries = maxEntries;
  }

  async get(
    oldText: string,
    newText: string,
  ): Promise<
    | {
        additions: number;
        deletions: number;
        structured: RuntimeStructuredDiff;
      }
    | undefined
  > {
    const key = this.key(oldText, newText);
    const entry = await this.objects.getMeta<StructuredDiffCacheEntry>(key);
    if (
      entry &&
      entry.oldSha256 === this.hash(oldText) &&
      entry.newSha256 === this.hash(newText)
    ) {
      this.touch(key);
      return {
        additions: entry.additions,
        deletions: entry.deletions,
        structured: entry.structured,
      };
    }
    return undefined;
  }

  async set(
    oldText: string,
    newText: string,
    result: {
      additions: number;
      deletions: number;
      structured: RuntimeStructuredDiff;
    },
  ): Promise<void> {
    const key = this.key(oldText, newText);
    await this.objects.putMeta(key, {
      oldSha256: this.hash(oldText),
      newSha256: this.hash(newText),
      additions: result.additions,
      deletions: result.deletions,
      structured: result.structured,
    } satisfies StructuredDiffCacheEntry);
    this.touch(key);
  }

  private touch(key: string): void {
    if (!this.seen.has(key)) {
      if (this.seenOrder.length >= this.maxEntries) {
        const oldest = this.seenOrder.shift();
        if (oldest) {
          this.seen.delete(oldest);
          void this.objects.deleteMeta(oldest);
        }
      }
      this.seen.add(key);
      this.seenOrder.push(key);
      return;
    }
    const index = this.seenOrder.indexOf(key);
    if (index >= 0) {
      this.seenOrder.splice(index, 1);
      this.seenOrder.push(key);
    }
  }

  private key(oldText: string, newText: string): string {
    return `${this.namespace}:${this.hash(oldText)}:${this.hash(newText)}`;
  }

  private hash(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }
}
