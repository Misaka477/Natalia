/**
 * §3.6.9's decision mechanized: the desktop shell is CEF — Electron is
 * history, and the audit's lesson was a FALSE "already deleted" claim
 * surviving in docs while nobody could re-check it. This rule makes the
 * claim re-checkable on every verify, three bites per the audit's own
 * residue list:
 *  1. workspace manifests declaring electron/electron-builder as a
 *     dependency (the app's whole class: it was the ONLY package that
 *     ever did);
 *  2. source files referencing electron (the "29 dead branches" class);
 *  3. README/docs referencing it (the audit's recipe step 3).
 *
 * `electron-to-chromium` is a browserslist DATABASE package (a normal
 * web-tooling transitive) — explicitly allowed, not the shell.
 */

const ELECTRON_WORD = /(?<![\w-])electron(?!-to-chromium)(?![\w-])/giu;
const ELECTRON_BUILDER = /(?<![\w-])electron-builder(?![\w-])/giu;

/** For source/README/docs text: any Electron or electron-builder mention. */
export function findElectronResidueInText(text: string): string | undefined {
  ELECTRON_WORD.lastIndex = 0;
  ELECTRON_BUILDER.lastIndex = 0;
  const builder = ELECTRON_BUILDER.exec(text);
  if (builder) return `electron-builder mentioned (${builder.index})`;
  const shell = ELECTRON_WORD.exec(text);
  if (shell) return `electron mentioned (${shell.index})`;
  return undefined;
}

/** For a workspace manifest's dependency maps (dev included: the class
 * was the app declaring it, not shipping it). */
export function findElectronDependency(manifest: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}): string | undefined {
  for (const map of [manifest.dependencies, manifest.devDependencies])
    for (const name of Object.keys(map ?? {}))
      if (name === "electron" || name === "electron-builder")
        return `${name} is declared as a dependency`;
  return undefined;
}
