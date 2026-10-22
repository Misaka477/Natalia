import { expect, test } from "bun:test";
import { slashQuery } from "../src/controllers/slash-menu";

test("a leading slash opens the menu and the rest is the filter", () => {
  expect(slashQuery("/")).toBe("");
  expect(slashQuery("/设")).toBe("设");
  expect(slashQuery("/设置")).toBe("设置");
});

test("a space after the command closes the menu: the message begins", () => {
  // "/设置 " means the human finished the command and is writing the
  // message; keeping the menu open would cover what they are typing.
  expect(slashQuery("/设置 ")).toBeUndefined();
  expect(slashQuery("/a b")).toBeUndefined();
});

test("a draft without a leading slash keeps the menu closed", () => {
  expect(slashQuery("")).toBeUndefined();
  expect(slashQuery("hello")).toBeUndefined();
  expect(slashQuery("请用 / 分隔")).toBeUndefined();
  // A slash mid-draft is a path or a smiley, not a command.
  expect(slashQuery("a/b")).toBeUndefined();
  expect(slashQuery("查看 /tmp")).toBeUndefined();
});
