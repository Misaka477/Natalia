import { expect, test } from "bun:test";
import type { RuntimeClient, RuntimeEvent } from "@anthelia/contracts";
import { createUiPluginHost, defineUiPlugin } from "../src";

function fakeRoot(): HTMLElement {
  const node = {
    tagName: "DIV",
    children: [] as unknown[],
    innerHTML: "",
    textContent: "",
    replaceChildren() {
      node.children = [];
      node.innerHTML = "";
      node.textContent = "";
    },
    appendChild(child: unknown) {
      node.children.push(child);
      return child;
    },
  };
  return node as unknown as HTMLElement;
}

function runtimeFixture() {
  let sink: ((event: RuntimeEvent) => void) | undefined;
  const submissions: string[] = [];
  const chat: string[] = [];
  const runtime = {
    start(next: (event: RuntimeEvent) => void) {
      sink = next;
      next({
        type: "session.created",
        sessionID: "ses_fixture" as never,
        title: "Fixture",
      });
      next({
        type: "session.ready",
        sessionID: "ses_fixture" as never,
      });
    },
    async submit(text: string) {
      submissions.push(text);
      const id = `turn_${submissions.length}`;
      sink?.({
        type: "turn.submitted",
        id,
        text,
        byteLength: text.length,
        lineCount: 1,
        sha256: "x",
      });
      sink?.({ type: "content.done", id, text: `echo:${text}` });
      return {
        type: "turn.submitted" as const,
        id,
        text,
        byteLength: text.length,
        lineCount: 1,
        sha256: "x",
      };
    },
    naviChat: {
      async submit(input: { text: string }) {
        chat.push(input.text);
        sink?.({
          type: "navi.chat.message.added",
          id: "chat_1",
          messageID: "msg_1",
          role: "user",
          text: input.text,
          at: "now",
        });
        return { messageID: "msg_1" };
      },
    },
    cancel() {},
  } as unknown as RuntimeClient;
  return {
    runtime,
    submissions: () => submissions,
    chat: () => chat,
    emit(event: RuntimeEvent) {
      sink?.(event);
    },
  };
}

test("the host loads a UI plugin, forwards events, and unloads it", async () => {
  const root = fakeRoot();
  const fixture = runtimeFixture();
  const seen: string[] = [];
  const plugin = defineUiPlugin({
    id: "example.web",
    name: "Example",
    version: "1.0.0",
    events: ["runtime.*"],
    panels: [
      { id: "main", title: "Main", region: "main" },
      { id: "chat", title: "Chat", region: "side" },
    ],
    commands: [
      {
        id: "example.ping",
        title: "Ping",
        run: () => "pong",
      },
    ],
    mount(ctx) {
      seen.push("mount");
      ctx.root.textContent = "plugin-root";
      const off = ctx.events.subscribe((event) => seen.push(event.type));
      return {
        dispose() {
          off();
          seen.push("dispose");
          ctx.root.textContent = "";
        },
      };
    },
  });
  const host = await createUiPluginHost({ root, runtime: fixture.runtime });
  const loaded = await host.load(plugin);
  host.projection.activateSession?.("ses_fixture");
  expect(loaded.panels.map((panel) => panel.id)).toEqual(["main", "chat"]);
  expect(host.loaded()).toHaveLength(1);
  expect(host.projection.getState().sessionID).toBe("ses_fixture");
  expect(host.projection.getState().title).toBe("Fixture");
  expect(await host.executeCommand("example.ping")).toBe("pong");
  await host.executeCommand("runtime.submit", "hello");
  expect(fixture.submissions()).toEqual(["hello"]);
  expect(host.projection.getState().messages.length).toBeGreaterThan(0);
  await host.executeCommand("runtime.chatSubmit", { text: "navi" });
  expect(fixture.chat()).toEqual(["navi"]);
  expect(host.projection.getState().navi.messages).toHaveLength(1);
  await host.unload("example.web");
  expect(host.loaded()).toHaveLength(0);
  expect(root.textContent).toBe("");
  expect(seen).toEqual([
    "mount",
    "session.created",
    "session.ready",
    "turn.submitted",
    "content.done",
    "navi.chat.message.added",
    "dispose",
  ]);
  await host.close();
});

test("loading the same UI plugin twice is rejected", async () => {
  const root = fakeRoot();
  const fixture = runtimeFixture();
  const plugin = defineUiPlugin({
    id: "example.web",
    name: "Example",
    version: "1.0.0",
    mount() {},
  });
  const host = await createUiPluginHost({ root, runtime: fixture.runtime });
  await host.load(plugin);
  await expect(host.load(plugin)).rejects.toThrow(
    "ui plugin already loaded: example.web",
  );
  await expect(host.executeCommand("missing")).rejects.toThrow(
    "command unavailable: missing",
  );
  await host.close();
});

test("the host does not paint business panels itself", async () => {
  const root = fakeRoot();
  const fixture = runtimeFixture();
  const host = await createUiPluginHost({ root, runtime: fixture.runtime });
  expect(root.textContent).toBe("");
  expect(root.innerHTML).toBe("");
  await host.close();
});

test("unloading stops event delivery and a closed host refuses new plugins", async () => {
  const root = fakeRoot();
  const fixture = runtimeFixture();
  const seen: string[] = [];
  const plugin = defineUiPlugin({
    id: "example.web",
    name: "Example",
    version: "1.0.0",
    mount(ctx) {
      const off = ctx.events.subscribe((event) => seen.push(event.type));
      return { dispose: off };
    },
  });
  const host = await createUiPluginHost({ root, runtime: fixture.runtime });
  await host.load(plugin);
  await host.unload("example.web");
  fixture.emit({
    type: "turn.started",
    id: "t-late",
  });
  expect(seen).toEqual(["session.created", "session.ready"]);
  await host.close();
  await expect(
    host.load(
      defineUiPlugin({
        id: "late",
        name: "Late",
        version: "1.0.0",
        mount() {},
      }),
    ),
  ).rejects.toThrow("ui plugin host is closed");
});

test("background session events stay cached across A to B to A activation", async () => {
  const fixture = runtimeFixture();
  const host = await createUiPluginHost({
    root: fakeRoot(),
    runtime: fixture.runtime,
  });
  await host.load(
    defineUiPlugin({ id: "cache", name: "Cache", version: "1", mount() {} }),
  );
  fixture.emit({
    type: "session.created",
    sessionID: "ses_a" as never,
    title: "A",
  });
  fixture.emit({
    type: "turn.submitted",
    id: "a1",
    text: "first",
    byteLength: 5,
    lineCount: 1,
    sha256: "x",
    sessionID: "ses_a" as never,
  });
  host.projection.activateSession?.("ses_b");
  fixture.emit({
    type: "content.delta",
    id: "a1",
    text: "background",
    sessionID: "ses_a" as never,
  });
  fixture.emit({
    type: "session.created",
    sessionID: "ses_b" as never,
    title: "B",
  });
  fixture.emit({
    type: "turn.submitted",
    id: "b1",
    text: "other",
    byteLength: 5,
    lineCount: 1,
    sha256: "x",
    sessionID: "ses_b" as never,
  });
  host.projection.activateSession?.("ses_a");
  expect(
    host.projection
      .getState()
      .messages.map((message) => message.text + message.pendingText),
  ).toContain("background");
  expect(
    host.projection.getState().messages.map((message) => message.text),
  ).not.toContain("other");
  await host.close();
});

test("workspace keys isolate identical session IDs", async () => {
  const fixture = runtimeFixture();
  const host = await createUiPluginHost({
    root: fakeRoot(),
    runtime: fixture.runtime,
  });
  await host.load(
    defineUiPlugin({
      id: "workspace-cache",
      name: "Workspace cache",
      version: "1",
      mount() {},
    }),
  );
  fixture.emit({
    type: "turn.submitted",
    id: "one",
    text: "workspace one",
    byteLength: 13,
    lineCount: 1,
    sha256: "x",
    sessionID: "ses_shared" as never,
    workspaceID: "one",
  });
  fixture.emit({
    type: "turn.submitted",
    id: "two",
    text: "workspace two",
    byteLength: 13,
    lineCount: 1,
    sha256: "x",
    sessionID: "ses_shared" as never,
    workspaceID: "two",
  });
  host.projection.activateSession?.("ses_shared", "one");
  expect(
    host.projection.getState().messages.map((message) => message.text),
  ).toContain("workspace one");
  expect(
    host.projection.getState().messages.map((message) => message.text),
  ).not.toContain("workspace two");
  host.projection.activateSession?.("ses_shared", "two");
  expect(
    host.projection.getState().messages.map((message) => message.text),
  ).toContain("workspace two");
  await host.close();
});

test("unloading a plugin disposes the panels it mounted", async () => {
  // `mountPanel` only disposes the previous panel for the same key, so nothing
  // removed a plugin's panels when the plugin itself went away: the DOM, timers
  // and listeners stayed, and a later install mounted a second copy beside them.
  const root = fakeRoot();
  const fixture = runtimeFixture();
  const seen: string[] = [];
  const plugin = defineUiPlugin({
    id: "panels.web",
    name: "Panels",
    version: "1.0.0",
    panels: [
      { id: "main", title: "Main", region: "main" },
      {
        id: "chat",
        title: "Chat",
        region: "side",
        mount: () => () => {
          seen.push("panel-chat-disposed");
        },
      },
    ],
    mount: () => ({
      dispose: () => {
        seen.push("plugin-disposed");
      },
    }),
  });
  const host = await createUiPluginHost({ root, runtime: fixture.runtime });
  await host.load(plugin);
  const container = fakeRoot();
  await host.mountPanel("panels.web", "chat", container);

  await host.unload("panels.web");

  expect(seen).toEqual(["panel-chat-disposed", "plugin-disposed"]);
  // Removed as well as disposed: a listener reading the mount set must not see a
  // panel belonging to a plugin that is gone.
  await expect(
    host.mountPanel("panels.web", "chat", fakeRoot()),
  ).rejects.toThrow(/ui plugin not loaded/);
  await host.close();
});

test("remounting the same panel key disposes the previous panel first", async () => {
  // The web shell's side panel is keyed and re-mounts on every tab switch; it
  // never calls an explicit unmount (audit B-03). The host's per-key dispose in
  // mountPanel is what stops a re-mount from stacking a second live copy beside
  // the first, so it is the invariant the component leans on.
  const root = fakeRoot();
  const fixture = runtimeFixture();
  const seen: string[] = [];
  const plugin = defineUiPlugin({
    id: "panels.web",
    name: "Panels",
    version: "1.0.0",
    panels: [
      {
        id: "chat",
        title: "Chat",
        region: "side",
        mount: () => {
          seen.push("mount");
          return () => {
            seen.push("dispose");
          };
        },
      },
    ],
    mount: () => undefined,
  });
  const host = await createUiPluginHost({ root, runtime: fixture.runtime });
  await host.load(plugin);

  await host.mountPanel("panels.web", "chat", fakeRoot());
  await host.mountPanel("panels.web", "chat", fakeRoot());

  // Each re-mount tears down the panel it replaces before mounting the next.
  expect(seen).toEqual(["mount", "dispose", "mount"]);
  await host.close();
});

test("remounting a panel into the same container replaces its DOM", async () => {
  // The field report: the terminal occupied exactly half the sidebar's height
  // and the console showed the panel's cleanup running. The host disposed the
  // previous panel (its listeners) but never cleared the container it mounted
  // into, so every re-mount APPENDED a second root. The mount slot is a flex
  // column, so two pane roots split the height between them — the terminal got
  // ~597px of a 1193px sidebar and the rest went to the stale copy's empty box.
  const root = fakeRoot();
  const fixture = runtimeFixture();
  const disposals: string[] = [];
  const plugin = defineUiPlugin({
    id: "panels.web",
    name: "Panels",
    version: "1.0.0",
    panels: [
      {
        id: "chat",
        title: "Chat",
        region: "side",
        mount: (ctx, container) => {
          container.appendChild(fakeRoot());
          return () => {
            disposals.push("chat");
          };
        },
      },
    ],
    mount: () => undefined,
  });
  const host = await createUiPluginHost({ root, runtime: fixture.runtime });
  await host.load(plugin);

  // The web shell's side panel is keyed and re-mounts into the SAME element on
  // every activation, so the container is reused rather than replaced.
  const container = fakeRoot();
  await host.mountPanel("panels.web", "chat", container);
  expect(container.children).toHaveLength(1);
  await host.mountPanel("panels.web", "chat", container);
  expect(container.children).toHaveLength(1);
  await host.mountPanel("panels.web", "chat", container);
  expect(container.children).toHaveLength(1);
  // Disposal still happens once per replaced panel.
  expect(disposals).toEqual(["chat", "chat"]);
  await host.close();
});

/** A runtime whose catalog declares panels (the arm source). */
function catalogRuntimeFixture(
  catalog: Array<{
    id: string;
    ui?: { panels: Array<{ id: string; title: string; region: string }> };
  }>,
) {
  const runtime = {
    start() {
      return () => undefined;
    },
    pluginCatalog: async () =>
      catalog.map((entry) => ({
        id: entry.id,
        name: entry.id,
        version: "1.0.0",
        enabled: true,
        installed: true,
        packageName: null,
        ...(entry.ui ? { ui: entry.ui } : {}),
      })),
  } as unknown as RuntimeClient;
  return runtime;
}

test("arming the catalog lists declared panels without loading bundles", async () => {
  // Spec §2.3 stage 1: the shell renders the region from the catalog;
  // not a single bundle is fetched until a mount asks for one.
  const root = fakeRoot();
  const runtime = catalogRuntimeFixture([
    {
      id: "settings.plugin",
      ui: {
        panels: [
          { id: "skills-settings", title: "Skills", region: "settings" },
        ],
      },
    },
    { id: "no.ui.plugin" },
  ]);
  const host = await createUiPluginHost({ root, runtime });
  const armed = await host.armPanelsFromCatalog();
  expect(armed).toBe(1);
  const listed = host.listPanels();
  expect(listed).toHaveLength(1);
  expect(listed[0]!.pluginId).toBe("settings.plugin");
  expect(listed[0]!.panel.id).toBe("skills-settings");
  // The armed row carries a working mount (the rail lists only mountable
  // panels): a metadata row whose mount LOADS the bundle on demand.
  expect(typeof listed[0]!.panel.mount).toBe("function");
  // Nothing loaded: the arm is a declaration, not an activation.
  expect(host.loaded()).toHaveLength(0);
  await host.close();
});

test("a panel mount activates the unloaded plugin through the seam", async () => {
  // Stage 2: the mount IS the activation event — the host asks the
  // seam to load the plugin, then mounts normally.
  const root = fakeRoot();
  const runtime = catalogRuntimeFixture([
    {
      id: "lazy.plugin",
      ui: { panels: [{ id: "main", title: "Main", region: "settings" }] },
    },
  ]);
  const activations: string[] = [];
  const host = await createUiPluginHost({
    root,
    runtime,
    ensurePluginLoaded: async (pluginID) => {
      activations.push(pluginID);
      await host2.load(
        defineUiPlugin({
          id: pluginID,
          name: "Lazy",
          version: "1.0.0",
          mount() {},
          panels: [
            {
              id: "main",
              title: "Main",
              region: "settings",
              mount(_ctx, container) {
                container.textContent = "lazy-mounted";
              },
            },
          ],
        }),
      );
    },
  });
  const host2 = host;
  await host.armPanelsFromCatalog();
  const container = fakeRoot();
  await host.mountPanel("lazy.plugin", "main", container);
  expect(activations).toEqual(["lazy.plugin"]);
  expect(container.textContent).toBe("lazy-mounted");
  // The armed row did not duplicate beside the mounted one: one row, and
  // the loaded plugin's panel (with its mount) is what answers.
  expect(
    host.listPanels().map((row) => ({
      pluginId: row.pluginId,
      id: row.panel.id,
    })),
  ).toEqual([{ pluginId: "lazy.plugin", id: "main" }]);
  expect(host.loaded().map((entry) => entry.plugin.id)).toEqual([
    "lazy.plugin",
  ]);
  await host.close();
});

test("an armed row's mount loads the bundle and delegates (the rail regression)", async () => {
  // The bug this pins: the rail lists only panels whose mount is a
  // function, so an armed metadata row (no mount) vanished from it and
  // the plugin's tab disappeared. The armed row now carries a mount that
  // loads through the seam and delegates to the real panel.
  const root = fakeRoot();
  const runtime = catalogRuntimeFixture([
    {
      id: "lazy.rail",
      ui: { panels: [{ id: "rail", title: "Rail", region: "side" }] },
    },
  ]);
  const activations: string[] = [];
  let host: Awaited<ReturnType<typeof createUiPluginHost>>;
  host = await createUiPluginHost({
    root,
    runtime,
    ensurePluginLoaded: async (pluginID) => {
      activations.push(pluginID);
      await host.load(
        defineUiPlugin({
          id: pluginID,
          name: "Lazy",
          version: "1.0.0",
          mount() {},
          panels: [
            {
              id: "rail",
              title: "Rail",
              region: "side",
              mount(_ctx, container) {
                container.textContent = "rail-mounted";
              },
            },
          ],
        }),
      );
    },
  });
  await host.armPanelsFromCatalog();
  // The rail's own filter: a listed panel must have a mount.
  const row = host
    .listPanels()
    .find((item) => item.panel.id === "rail" && item.pluginId === "lazy.rail");
  expect(row).toBeDefined();
  const container = fakeRoot();
  // The fixture's panel mount ignores its ctx, so a minimal stand-in is
  // the honest argument.
  await row!.panel.mount!({ root } as never, container);
  expect(activations).toEqual(["lazy.rail"]);
  expect(container.textContent).toBe("rail-mounted");
  await host.close();
});

test("without the seam a mount of an unloaded plugin fails loud", async () => {
  // The degradation is not silent: a host that wires no activation hook
  // keeps the old behaviour, named.
  const root = fakeRoot();
  const runtime = catalogRuntimeFixture([
    {
      id: "eager.plugin",
      ui: { panels: [{ id: "main", title: "Main", region: "settings" }] },
    },
  ]);
  const host = await createUiPluginHost({ root, runtime });
  await host.armPanelsFromCatalog();
  await expect(
    host.mountPanel("eager.plugin", "main", fakeRoot()),
  ).rejects.toThrow("ui plugin not loaded: eager.plugin");
  await host.close();
});
