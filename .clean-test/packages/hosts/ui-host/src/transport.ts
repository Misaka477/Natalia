import type { UiTransport } from "./protocol";

export function createMemoryTransport(
  files: Map<string, Uint8Array> = new Map(),
): UiTransport {
  return {
    async readFile(path) {
      const data = files.get(path);
      if (!data) throw new Error(`file not found: ${path}`);
      return data;
    },
    async writeFile(path, data) {
      files.set(path, data);
    },
  };
}

export function createWebTransport(
  files: Map<string, Uint8Array> = new Map(),
): UiTransport {
  return {
    async readFile(path) {
      const data = files.get(path);
      if (!data) throw new Error(`web transport cannot read ${path}`);
      return data;
    },
    async writeFile(path, data) {
      files.set(path, data);
    },
    async openPath(path) {
      throw new Error(`web transport cannot open ${path}`);
    },
    async readClipboardImage() {
      if (typeof navigator === "undefined" || !navigator.clipboard?.read)
        return undefined;
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((entry) => entry.startsWith("image/"));
        if (!type) continue;
        const blob = await item.getType(type);
        return new Uint8Array(await blob.arrayBuffer());
      }
      return undefined;
    },
  };
}
