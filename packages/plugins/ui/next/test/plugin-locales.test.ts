import { expect, test } from "bun:test";
import { LocaleRuntime } from "../src/locale/runtime";

async function loadPack(relativePath: string): Promise<{
  zh: Record<string, string>;
  en: Record<string, string>;
}> {
  return (await import(new URL(relativePath, import.meta.url).href)) as {
    zh: Record<string, string>;
    en: Record<string, string>;
  };
}

test("all four plugin UI language packs have complete zh-CN and en dictionaries", async () => {
  const paths = [
    "../../../native-terminal/src/ui/locales.ts",
    "../../file-editor/src/locales.ts",
    "../../../mcp/src/ui/locales.ts",
    "../../../skills/src/ui/locales.ts",
  ];
  for (const path of paths) {
    const pack = await loadPack(path);
    expect(Object.keys(pack.en).sort()).toEqual(Object.keys(pack.zh).sort());
    for (const value of Object.values({ ...pack.zh, ...pack.en })) {
      expect(value.length).toBeGreaterThan(0);
    }
  }
});

test("plugin language packs switch together with the shell's LocaleRuntime", async () => {
  const term = await loadPack("../../../native-terminal/src/ui/locales.ts");
  const file = await loadPack("../../file-editor/src/locales.ts");
  const mcp = await loadPack("../../../mcp/src/ui/locales.ts");
  const skills = await loadPack("../../../skills/src/ui/locales.ts");

  const runtime = new LocaleRuntime();
  runtime.ensureRegistered("terminal", { "zh-CN": term.zh, en: term.en });
  runtime.ensureRegistered("file-editor", { "zh-CN": file.zh, en: file.en });
  runtime.ensureRegistered("mcp", { "zh-CN": mcp.zh, en: mcp.en });
  runtime.ensureRegistered("skills", { "zh-CN": skills.zh, en: skills.en });

  expect(runtime.bind("terminal")("terminal.ownerHuman")).toBe("人工控制");
  expect(runtime.bind("file-editor")("files.explorer")).toBe("资源管理器");
  expect(runtime.bind("mcp")("mcp.title")).toBe("MCP 配置");
  expect(runtime.bind("skills")("skills.title")).toBe("Skill 配置");

  runtime.setLocale("en");
  expect(runtime.bind("terminal")("terminal.ownerHuman")).toBe("Human control");
  expect(runtime.bind("file-editor")("files.explorer")).toBe("Explorer");
  expect(runtime.bind("mcp")("mcp.title")).toBe("MCP Configuration");
  expect(runtime.bind("skills")("skills.title")).toBe("Skills Configuration");
});
