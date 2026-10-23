/**
 * The one main pane switches between four agents.
 *
 * The defect this pins: the pane's switcher offered two — Natalia and
 * Navi — while Nia and the team of subagents were tabs in the right
 * rail. Two whole agents therefore lived one click away from the
 * conversation surface, and the pane's header advertised a choice it did
 * not have. The reader's ruling was explicit: the single pane has four
 * agent switches.
 *
 * So the pane owns all four, the rail keeps the three review surfaces
 * (diff, plan, governance) plus whatever panels plugins register, and
 * the switcher's order is data (`PANE_AGENTS`) rather than four
 * hand-written buttons that can drift apart.
 */
import { expect, test } from "bun:test";

const read = (path: string) =>
  Bun.file(
    new URL(`../src/${path}`, import.meta.url).pathname.replace(
      /^\/([A-Za-z]:)/u,
      "$1",
    ),
  ).text();

test("the pane switches between all four agents", async () => {
  const pane = await read("controllers/transcript.tsx");
  expect(pane).toContain(
    'export type PaneAgent = "natalia" | "navi" | "nia" | "team";',
  );
  expect(pane).toContain(
    'const PANE_AGENTS: readonly PaneAgent[] = ["natalia", "navi", "nia", "team"];',
  );
  // The switcher is rendered from that list, so a fifth agent is one
  // entry rather than another copy of the button.
  expect(pane).toContain("<For each={PANE_AGENTS}>");
  expect(pane).toContain("{t(`transcript.agent.${agent}`)}");
});

test("every agent has a body in the pane", async () => {
  const pane = await read("controllers/transcript.tsx");
  for (const agent of ["natalia", "navi", "nia", "team"] as const) {
    expect(pane).toContain(`focusAgent() === "${agent}"`);
  }
  // The two that moved out of the rail are rendered here, by name.
  expect(pane).toContain("<NiaPanel");
  expect(pane).toContain("<AgentPanel");
  // Nia drops her own header: the pane's header carries the switcher
  // and the running state, and a second one would stack under it.
  expect(pane).toContain("embedded");
});

test("the right rail no longer hosts the two agent tabs", async () => {
  const rail = await read("controllers/workbench.tsx");
  expect(rail).not.toContain("<NiaPanel");
  expect(rail).not.toContain("<AgentPanel");
  const app = await read("app-neu.tsx");
  expect(app).not.toContain('{ id: "nia", label: t("tab.nia") }');
  expect(app).not.toContain('{ id: "agent", label: t("tab.agent") }');
  // The deep link from the team panel to a terminal still works: the
  // shell opens the rail on the terminal the panel names.
  expect(app).toContain("function openTerminal(terminalID: string)");
  expect(app).toContain('setRightTab(terminalID || "terminal")');
});

test("each agent's label exists in both dictionaries", async () => {
  for (const locale of ["zh", "en"]) {
    const source = await read(`locales/${locale}.ts`);
    for (const agent of ["natalia", "navi", "nia", "team"]) {
      expect(source).toContain(`"transcript.agent.${agent}"`);
    }
  }
});
