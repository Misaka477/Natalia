import { expect, test } from "bun:test";
import {
  findElectronDependency,
  findElectronResidueInText,
} from "../src/electron-residue-rules";

/**
 * §3.6.9 mechanized — the audit's own residue list as three bites, so
 * a "already deleted" claim can never go false silently again.
 */

test("source/docs text: Electron and electron-builder trip, the browserslist db does not", () => {
  expect(
    findElectronResidueInText("if (globalThis.electron) ipc.send();"),
  ).toBeTruthy();
  expect(findElectronResidueInText('"electron-builder": "^44"')).toBeTruthy();
  expect(
    findElectronResidueInText("See electron-to-chromium for browser data."),
  ).toBeUndefined(); // a transitive DATA package, not the shell
  expect(findElectronResidueInText("the CLI reads files")).toBeUndefined();
});

test("manifests: declaring the shell as a dependency trips; normal web deps pass", () => {
  expect(
    findElectronDependency({ dependencies: { electron: "^33.0.0" } }),
  ).toBeTruthy();
  expect(
    findElectronDependency({ devDependencies: { "electron-builder": "^44" } }),
  ).toBeTruthy();
  expect(
    findElectronDependency({ dependencies: { vite: "^7.1.5" } }),
  ).toBeUndefined();
  expect(
    findElectronDependency({
      dependencies: { "electron-to-chromium": "^1.5" },
    }),
  ).toBeUndefined();
});
