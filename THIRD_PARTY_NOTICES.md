# Third-Party Notices

Natalia is licensed under Apache-2.0. It uses the third-party software listed below. License texts included in installed packages are collected in `THIRD_PARTY_LICENSES.txt`; packages whose npm artifacts omit a standalone license file remain identified there by exact package, version, and declared SPDX license.

## Direct Runtime Dependencies

| Package                        | Version | License    | Source                                                 |
| ------------------------------ | ------: | ---------- | ------------------------------------------------------ |
| `solid-js`                     |  1.9.12 | MIT        | <https://github.com/solidjs/solid>                     |
| `zod`                          | 3.25.76 | MIT        | <https://github.com/colinhacks/zod>                    |
| `marked`                       |  17.0.1 | MIT        | <https://github.com/markedjs/marked>                   |
| `lowlight`                     |  ^3.3.0 | MIT        | <https://github.com/wooorm/lowlight>                   |
| `fuzzysort`                    |   3.1.0 | MIT        | <https://github.com/farzher/fuzzysort>                 |
| `@tanstack/solid-virtual`      | 3.13.37 | MIT        | <https://github.com/TanStack/virtual>                  |
| `codemirror` & `@codemirror/*` |  ^6.0.0 | MIT        | <https://github.com/codemirror/dev>                    |
| `@lezer/highlight`             |  ^1.2.0 | MIT        | <https://github.com/lezer-parser/highlight>            |
| `@xterm/xterm` & `@xterm/*`    |   5.5.0 | MIT        | <https://github.com/xtermjs/xterm.js>                  |
| `@jsquash/jpeg`                |   1.6.0 | Apache-2.0 | <https://github.com/jamsinclair/jSquash>               |
| `@jsquash/png`                 |   3.1.1 | Apache-2.0 | <https://github.com/jamsinclair/jSquash>               |
| `@jsquash/resize`              |   2.1.1 | Apache-2.0 | <https://github.com/jamsinclair/jSquash>               |
| `@jsquash/webp`                |   1.5.0 | Apache-2.0 | <https://github.com/jamsinclair/jSquash>               |
| `web-tree-sitter`              |      \* | MIT        | <https://github.com/tree-sitter/tree-sitter>           |
| `@vscode/tree-sitter-wasm`     |      \* | MIT        | <https://github.com/microsoft/vscode-tree-sitter-wasm> |

## Direct Development & Build Dependencies

| Package             | Version | License    | Source                                         |
| ------------------- | ------: | ---------- | ---------------------------------------------- |
| `typescript`        |   5.8.2 | Apache-2.0 | <https://github.com/microsoft/TypeScript>      |
| `vite`              |   7.1.5 | MIT        | <https://github.com/vitejs/vite>               |
| `vite-plugin-solid` | 2.11.10 | MIT        | <https://github.com/solidjs/vite-plugin-solid> |
| `prettier`          |   3.6.2 | MIT        | <https://github.com/prettier/prettier>         |
| `@resvg/resvg-js`   |   2.6.2 | MPL-2.0    | <https://github.com/yisibl/resvg-js>           |
| `svgo`              |   4.1.0 | MIT        | <https://github.com/svg/svgo>                  |
| `@types/bun`        |  1.3.13 | MIT        | <https://github.com/oven-sh/bun>               |
| `@tsconfig/bun`     |   1.0.9 | MIT        | <https://github.com/tsconfig/bases>            |

## Transitive Dependency Licenses

The locked dependency tree contains packages under these permissive and weak-copyleft licenses:

- MIT
- Apache-2.0
- ISC
- BSD-2-Clause
- BSD-3-Clause
- 0BSD
- BlueOak-1.0.0
- CC0-1.0
- MPL-2.0
- Python-2.0
- CC-BY-4.0 (`caniuse-lite` browser compatibility data)

No GPL, LGPL, or AGPL npm package is present in the locked dependency tree.

Before each release, run `npm run licenses:check`. It validates workspace license metadata and verifies that `THIRD_PARTY_LICENSES.txt` matches the installed dependency inventory.

## Native & Desktop Components

- **Chromium Embedded Framework (CEF)**: Used by the Windows/Linux desktop shell (`apps/cef-desktop`) under the BSD-3-Clause license (with Chromium's bundled third-party components under their respective licenses in the CEF distribution).
- **Rust Native Crates (`packages/hosts/confinement/native`, `packages/hosts/object-store/native`, `packages/framework/diff-wasm`)**: Compiled from Cargo workspaces using permissive crates (`serde`, `sha2`, `blake3`, `similar`, `tree-sitter`, etc.) under MIT / Apache-2.0.
- **Tree-sitter Grammar WASM Packs**: 44 precompiled language grammar `.wasm` artifacts built via `scripts/build-ast-packs.ts` and recorded in `toolchains/toolchains.json` under their respective upstream MIT / Apache-2.0 licenses.

## System Components

Natalia invokes or uses system/runtime components that are not incorporated into Natalia source code:

- **Bun runtime** (`https://bun.sh`), MIT license, used to execute and bundle the TypeScript runtime.
- **PowerShell (`pwsh`) / Windows ConPTY**: Invoked on Windows through `natalia-conpty-bridge.exe` for interactive PTY sessions.
- **Git / GNU Bash**: Invoked as external processes for version control and shell execution.
- **SQLite**: Public domain, accessed through `bun:sqlite`.

Redistributors that bundle Bun, CEF, Git, or another system component with Natalia must also satisfy that component's distribution and notice obligations. Calling a separately installed executable does not incorporate that executable into Natalia.
