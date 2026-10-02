# Third-Party Notices

Natalia CLI is licensed under Apache-2.0. It uses the third-party software below. This inventory describes the dependencies locked for the first TypeScript/Bun release. License texts included in installed packages are collected in `THIRD_PARTY_LICENSES.txt`; packages whose npm artifacts omit a standalone license file remain identified there by exact package, version, and declared SPDX license.

## Direct Runtime Dependencies

| Package           | Version | License | Source                                 |
| ----------------- | ------: | ------- | -------------------------------------- |
| `@opentui/core`   |   0.4.3 | MIT     | <https://github.com/anomalyco/opentui> |
| `@opentui/keymap` |   0.4.3 | MIT     | <https://github.com/anomalyco/opentui> |
| `@opentui/solid`  |   0.4.3 | MIT     | <https://github.com/anomalyco/opentui> |
| `solid-js`        |  1.9.12 | MIT     | <https://github.com/solidjs/solid>     |
| `zod`             | 3.25.76 | MIT     | <https://github.com/colinhacks/zod>    |
| `fuzzysort`       |   3.1.0 | MIT     | <https://github.com/farzher/fuzzysort> |
| `@xterm/headless` |   6.0.0 | MIT     | <https://github.com/xtermjs/xterm.js>  |

OpenTUI includes platform-specific native packages built from its Zig core. The locked OpenTUI core and platform packages declare the MIT license.

## Direct Development Dependencies

| Package         | Version | License    | Source                                    |
| --------------- | ------: | ---------- | ----------------------------------------- |
| `typescript`    |   5.8.2 | Apache-2.0 | <https://github.com/microsoft/TypeScript> |
| `prettier`      |   3.6.2 | MIT        | <https://github.com/prettier/prettier>    |
| `@types/bun`    |  1.3.13 | MIT        | <https://github.com/oven-sh/bun>          |
| `@tsconfig/bun` |   1.0.9 | MIT        | <https://github.com/tsconfig/bases>       |

## Transitive Dependency Licenses

The locked dependency tree currently contains packages under these licenses:

- MIT
- Apache-2.0
- BSD-2-Clause
- BSD-3-Clause
- ISC
- BlueOak-1.0.0
- CC-BY-4.0 (`caniuse-lite` browser compatibility data)

No GPL, LGPL, or AGPL npm package was identified in the locked dependency tree at the time this notice was prepared.

Before each release, run `npm run licenses:check`. It validates workspace license metadata and regenerates the machine-derived dependency inventory used by the release artifact.

## Vendored Components

Natalia vendors source trees that are compiled into its release artifacts and
therefore must keep their copyright and license notices with every
redistribution.

### WezTerm (Natalia fork)

The interactive terminal host is a patched fork of
[WezTerm](https://github.com/wez/wezterm), vendored under
`packages/plugins/native-terminal/wezterm` and pinned to upstream commit
`76b606ec597a3c0263fa60321548637451c0a547`. The fork adds an authenticated
input-claim exchange immediately before the pane write path (five files under
`wezterm-gui/src/termwindow/`); the full fork metadata, including build
commands, is recorded in `packages/plugins/native-terminal/wezterm-fork.json`.

WezTerm is licensed under the MIT License:

> MIT License
>
> Copyright (c) 2018-Present Wez Furlong
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
> FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
> IN THE SOFTWARE.

The upstream text lives at `packages/plugins/native-terminal/wezterm/LICENSE.md` and is
preserved there.

WezTerm bundles the `JetBrains Mono`, `Noto Color Emoji`, and `Roboto` fonts,
and a `Symbols Nerd Font Mono` build limited to icon sets distributed under the
OFL 1.1; the Pomicons set is excluded. Those fonts are distributed under the
SIL Open Font License 1.1, whose text is included in the vendored tree under
`packages/plugins/native-terminal/wezterm/assets/fonts`.

## System Components

Natalia invokes or uses system/runtime components that are not incorporated into Natalia source code:

- Bun runtime, primarily MIT with bundled third-party components under their respective licenses.
- Python, PSF License, currently used by the POSIX PTY bridge.
- GNU Bash, GPL-3.0-or-later, invoked as an external process.
- Git, GPL-2.0-only, invoked as an external process.
- SQLite, public domain, accessed through `bun:sqlite`.
- OpenSSL may be invoked by TLS tests and is not a normal runtime requirement.

Redistributors that bundle Bun, Python, Bash, Git, OpenSSL, or another system component with Natalia must also satisfy that component's distribution and source-notice obligations. Calling a separately installed executable does not incorporate that executable into Natalia.
