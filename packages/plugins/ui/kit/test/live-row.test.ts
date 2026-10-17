/**
 * The kit reads a row's moving parts through its live accessors.
 *
 * A host that keeps a row's object stable (so the DOM survives a streaming
 * delta) passes `contentLive` / `live`; every render site must prefer them. A
 * site still reading `message.content` would show the empty placeholder the host
 * stores for a live row, and `toolCall.output` would pin the arguments the call
 * had when the row was first built.
 */
import { expect, test } from "bun:test";
import {
  messageContent,
  toolCallView,
  type Message,
  type ToolCall,
} from "../src/message";

test("messageContent prefers the live accessor", () => {
  const staticRow: Message = { id: "m1", role: "assistant", content: "frozen" };
  expect(messageContent(staticRow)).toBe("frozen");
  const liveRow: Message = {
    id: "m2",
    role: "assistant",
    content: "",
    contentLive: () => "streamed",
  };
  expect(messageContent(liveRow)).toBe("streamed");
});

test("toolCallView prefers the live derivation", () => {
  const staticCall: ToolCall = { name: "read_file", output: "a" };
  expect(toolCallView(staticCall)).toBe(staticCall);
  const first: ToolCall = { name: "read_file", output: "a" };
  const liveCall: ToolCall = {
    ...first,
    live: () => ({ ...first, output: "ab" }),
  };
  expect(toolCallView(liveCall).output).toBe("ab");
});
