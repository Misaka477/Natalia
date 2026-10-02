/**
 * One-click helper for the Natalia Browser Bridge extension.
 *
 * - Ensures the local bridge server is running.
 * - Detects a Chromium browser (Chrome / Edge / Brave / Opera / Vivaldi / Arc).
 * - If the browser is not running, launches it with --load-extension.
 * - If the browser is already running, opens the extensions page and prints
 *   the folder to load.
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname; // packages/plugins/browser
const EXT_DIR = join(ROOT, "src/extension/chromium");
const BRIDGE_URL =
  process.env.NATALIA_BROWSER_BRIDGE_URL || "http://127.0.0.1:18765";

function isUp(url: string) {
  try {
    execSync(`curl -s --max-time 1 ${url}/healthz`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function startBridgeServer() {
  console.log("[natalia-browser-bridge] starting bridge server...");
  const child = spawn("bun", [join(ROOT, "src/server.ts")], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  for (let i = 0; i < 20; i += 1) {
    if (isUp(BRIDGE_URL)) return;
    sleep(300);
  }
}

function sleep(ms: number) {
  const now = Date.now();
  while (Date.now() - now < ms) {
    // busy wait acceptable for this helper
  }
}

function browserCandidates(): string[] {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    const roots = [
      process.env.LOCALAPPDATA,
      process.env.ProgramFiles,
      process.env.ProgramW6432,
    ].filter(Boolean) as string[];
    for (const root of roots) {
      for (const rel of [
        "Google/Chrome/Application/chrome.exe",
        "Chromium/Application/chrome.exe",
        "Microsoft/Edge/Application/msedge.exe",
        "BraveSoftware/Brave-Browser/Application/brave.exe",
        "Vivaldi/Application/vivaldi.exe",
      ])
        candidates.push(join(root, rel));
    }
  } else if (process.platform === "darwin") {
    for (const rel of [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
    ])
      candidates.push(rel);
  } else {
    for (const name of [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
      "microsoft-edge",
      "microsoft-edge-stable",
      "brave-browser",
      "opera",
      "vivaldi",
    ]) {
      try {
        const path = execSync(`command -v ${name}`, { stdio: "pipe" })
          .toString()
          .trim();
        if (path) candidates.push(path);
      } catch {}
    }
  }
  return candidates;
}

function realBrowserPath(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    return candidate;
  }
}

function isChromiumReal(candidate: string): boolean {
  const real = realBrowserPath(candidate).toLowerCase();
  return !/firefox|safari/i.test(real);
}

function findBrowser(): string | undefined {
  for (const candidate of browserCandidates()) {
    if (!existsSync(candidate)) continue;
    const real = realBrowserPath(candidate);
    if (/firefox|safari/i.test(real)) continue;
    return real;
  }
  return undefined;
}

function runningBrowserProcesses(): string[] {
  try {
    const out = execSync("ps -eo args", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .toLowerCase();
    const aliases: Array<[string[], string]> = [
      [["chrome", "google-chrome", "chromium"], "chrome"],
      [["msedge", "microsoft-edge", "microsoft-edge-stable"], "edge"],
      [["brave", "brave-browser"], "brave"],
      [["opera"], "opera"],
      [["vivaldi"], "vivaldi"],
    ];
    return browserCandidates()
      .map((candidate) => {
        const real = realBrowserPath(candidate);
        const name = real.split(/[\\/]/).pop()?.toLowerCase() || "";
        const processNames = aliases
          .filter(([names]) => names.includes(name))
          .flatMap(([, processName]) => [processName, name]);
        return { candidate: real, processNames };
      })
      .filter(
        ({ candidate, processNames }) =>
          !/firefox|safari/i.test(candidate) &&
          processNames.some((processName) => out.includes(processName)),
      )
      .map(({ candidate }) => candidate);
  } catch {
    return [];
  }
}

function extensionPageFor(browser: string): string {
  const name = browser.toLowerCase();
  if (name.includes("edge")) return "edge://extensions";
  return "chrome://extensions";
}

function isBrowserRunning() {
  return runningBrowserProcesses().length > 0;
}

async function main() {
  console.log("[natalia-browser-bridge] install helper");
  if (!isUp(BRIDGE_URL)) startBridgeServer();
  else
    console.log(
      `[natalia-browser-bridge] bridge already running at ${BRIDGE_URL}`,
    );

  const running = runningBrowserProcesses();
  const browser = running[0] || findBrowser();
  if (!browser) {
    console.error(
      "No supported Chromium browser found. Please install Chrome, Edge, Brave, Opera, Vivaldi or Arc.",
    );
    process.exit(1);
  }

  if (running[0])
    console.log(
      `[natalia-browser-bridge] detected running browser: ${browser}`,
    );
  else console.log(`[natalia-browser-bridge] browser: ${browser}`);

  if (/firefox|safari/i.test(browser)) {
    console.error(
      "This helper currently only auto-installs Chromium browsers.",
    );
    console.error("Firefox support is still under development.");
    process.exit(1);
  }

  console.log(`[natalia-browser-bridge] extension dir: ${EXT_DIR}`);

  if (!isBrowserRunning()) {
    console.log(
      "[natalia-browser-bridge] launching browser with --load-extension...",
    );
    const child = spawn(
      browser,
      [`--load-extension=${EXT_DIR}`, "about:blank"],
      {
        stdio: "ignore",
        detached: true,
      },
    );
    child.unref();
    console.log("Done. The extension should auto-connect.");
  } else {
    console.log("[natalia-browser-bridge] browser is already running.");
    const page = extensionPageFor(browser);
    console.log(`Open the extensions page and load the folder manually:`);
    console.log(`  ${page}`);
    console.log(`  then load unpacked folder: ${EXT_DIR}`);
    try {
      spawn(browser, [extensionPageFor(browser)], {
        stdio: "ignore",
        detached: true,
      }).unref();
      console.log(
        `Opened ${extensionPageFor(browser)} in the detected browser.`,
      );
    } catch {
      console.error("Could not open the extensions page automatically.");
    }
  }
}

await main();
