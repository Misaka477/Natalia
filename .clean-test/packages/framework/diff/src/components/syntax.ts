import { all, createLowlight } from "lowlight";

export type SyntaxPart = {
  text: string;
  cls: string;
};

const lowlight = createLowlight(all);

function walk(node: any, parts: SyntaxPart[]) {
  if (node.type === "text") {
    if (node.value) parts.push({ text: node.value, cls: "" });
    return;
  }
  if (node.type === "element") {
    const className = Array.isArray(node.properties?.className)
      ? node.properties.className.join(" ")
      : (node.properties?.className ?? "");
    const childParts: SyntaxPart[] = [];
    for (const child of node.children ?? []) walk(child, childParts);
    if (!childParts.length) return;
    // Merge contiguous tokens under the same class.
    for (const part of childParts) {
      const cls = className ? `${className} ${part.cls}`.trim() : part.cls;
      const last = parts.at(-1);
      if (last && last.cls === cls) last.text += part.text;
      else parts.push({ ...part, cls });
    }
    return;
  }
  for (const child of node.children ?? []) walk(child, parts);
}

const MAX_AUTO_HIGHLIGHT_LENGTH = 2_000;

export function highlightLine(text: string, language?: string): SyntaxPart[] {
  try {
    // highlightAuto is extremely expensive on long/generated lines. When no
    // language hint is available, render plain text instead of blocking the UI.
    if (!language && text.length > MAX_AUTO_HIGHLIGHT_LENGTH)
      return [{ text, cls: "" }];
    const tree =
      language && lowlight.registered(language)
        ? lowlight.highlight(language, text)
        : lowlight.highlightAuto(text);
    const parts: SyntaxPart[] = [];
    walk(tree, parts);
    return parts.length ? parts : [{ text, cls: "" }];
  } catch {
    return [{ text, cls: "" }];
  }
}
