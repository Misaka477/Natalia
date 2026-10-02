import { expect, test } from "bun:test";
import { PagedTranscriptController } from "@natalia/ui-kit";

test("paged transcript controller walks initial, older and newer pages", async () => {
  const pages = [
    { data: ["d", "e"], cursor: { previous: "older-1" } },
    {
      data: ["b", "c"],
      cursor: { previous: "older-2", next: "newer-1" },
    },
    { data: ["a"], cursor: { next: "newer-2" } },
    {
      data: ["b", "c"],
      cursor: { previous: "older-3", next: "newer-3" },
    },
  ];
  let index = 0;
  const applied: Array<{ direction: string; data: string[] }> = [];
  const controller = new PagedTranscriptController<string>({
    pageSize: 2,
    onPage: (page, direction) => {
      applied.push({ direction, data: page.data });
    },
  });
  controller.setSource(async () => {
    const page = pages[index];
    index += 1;
    if (!page) throw new Error("unexpected page request");
    return page;
  });

  await controller.loadInitial();
  expect(applied).toEqual([{ direction: "initial", data: ["d", "e"] }]);
  expect(controller.snapshot()).toMatchObject({
    initialized: true,
    hasOlder: true,
    hasNewer: false,
    loadingOlder: false,
  });

  await controller.loadOlder();
  expect(applied.at(-1)).toEqual({ direction: "older", data: ["b", "c"] });
  expect(controller.snapshot()).toMatchObject({
    hasOlder: true,
    hasNewer: true,
  });

  await controller.loadOlder();
  expect(applied.at(-1)).toEqual({ direction: "older", data: ["a"] });
  expect(controller.snapshot()).toMatchObject({
    hasOlder: false,
    hasNewer: true,
  });

  await controller.loadNewer();
  expect(applied.at(-1)).toEqual({ direction: "newer", data: ["b", "c"] });
  controller.dispose();
});

test("setSource resets cursors and ignores an in-flight older load", async () => {
  let release: (() => void) | undefined;
  const applied: string[] = [];
  const controller = new PagedTranscriptController<string>({
    pageSize: 1,
    onPage: (page, direction) => applied.push(`${direction}:${page.data[0]}`),
  });
  controller.setSource(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve({ data: ["stale"], cursor: { previous: "stale" } });
      }),
  );
  const pending = controller.loadInitial();
  controller.setSource(async () => ({
    data: ["fresh"],
    cursor: {},
  }));
  release?.();
  await pending.catch(() => undefined);
  await controller.loadInitial();
  expect(applied).toEqual(["initial:fresh"]);
  controller.dispose();
});
