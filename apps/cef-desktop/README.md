# Natalia CEF Desktop (migration spike)

Minimal CEF-based desktop shell prototype.

## Dependencies

- CEF SDK (Linux x64) extracted locally at `.cef-test/`

## The CEF sandbox is deliberately OFF

`CMakeLists.txt` does **not** define `CEF_USE_SANDBOX`, so cefsimple's
`settings.no_sandbox = true` compiles in. It was defined once, and that
was a misconfiguration rather than a hardening: the app links
`libcef_dll_wrapper` + `libcef.so` but not `cef_sandbox`, never calls
`cef_sandbox_initialize`, and passes `nullptr` as `CefInitialize`'s fourth
argument. A sandbox that is engaged by definition but never initialized
leaves the sub-processes under the seccomp policy with no broker behind
it — every temp-file create returns EPERM, which surfaces as

```
ERROR:third_party/puffin/src/puffpatch.cc:122 Failed to create a
temporary file for memory-mapping: Operation not permitted
```

Re-enabling it takes the whole set, not a flag: link `${CEF_SANDBOX_LIB}`,
call `cef_sandbox_initialize` in `main()`, pass the result as
`CefInitialize`'s fourth argument, and ship a root-owned setuid
`chrome_sandbox` that a user install cannot grant. The renderer renders
first-party UI served from the local runtime; the product's permission
model lives at the tool/approval layer, which the renderer sandbox does
not touch.

- CMake, `/usr/bin/g++`, X11 dev headers

## Build

```bash
cd apps/cef-desktop/build
CC=/usr/bin/gcc CXX=/usr/bin/g++ cmake .. -DCMAKE_BUILD_TYPE=Release
CC=/usr/bin/gcc CXX=/usr/bin/g++ cmake --build . -j4
```

The binary is produced at:

```text
apps/cef-desktop/build/output/natalia-cef-desktop
```

CEF runtime files are copied next to the binary automatically.

## Run (Wayland)

```bash
cd apps/cef-desktop/build/output
LD_LIBRARY_PATH=. ./natalia-cef-desktop \
  --url="http://127.0.0.1:8790" \
  --ozone-platform=wayland
```

Pass any Chromium/CEF switch through the command line, e.g.
`--force_high_performance_gpu`, `--disable-features=UseOzonePlatform`.

## Current state

- Empty CEF browser window works
- CEF 152 on niri/Wayland gets full hardware acceleration
- This is the base for the real migration: runtime spawning and IPC will be added next

## Run with Natalia runtime + web UI

```bash
apps/cef-desktop/run-cef-desktop.sh
```

This script starts:

- CLI runtime (`bun apps/cli/src/main.ts serve 8790`)
- Local static server for `apps/web/dist` on `127.0.0.1:5178`
- The CEF desktop window pointing at the web UI

## Launch command

```bash
npm run desktop:cef
```

The launcher defaults to:

- `NATALIA_FAST_EXECUTION_LOAD=1`
- `NATALIA_BROWSER_BRIDGE_URL=http://127.0.0.1:18765`

To override:

```bash
NATALIA_BROWSER_BRIDGE_URL=http://127.0.0.1:18765 npm run desktop:cef
```
