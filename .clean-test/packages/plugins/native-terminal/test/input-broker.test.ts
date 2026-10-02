import { expect, test } from "bun:test";
import {
  NATIVE_INPUT_BROKER_VERSION,
  decodeNativeInputClaim,
  decodeNativeInputDecision,
  encodeNativeInputDecision,
  nativeInputBrokerEndpoint,
  nativeInputBrokerDecision,
} from "../src";

test("encodes native claim decisions", () => {
  expect(
    decodeNativeInputDecision(
      encodeNativeInputDecision({
        version: NATIVE_INPUT_BROKER_VERSION,
        type: "decision",
        nonce: "nonce_1",
        permit: true,
        reason: "accepted",
      }),
    ),
  ).toMatchObject({ permit: true, reason: "accepted" });
});

test("accepts a byte-free native host pre-write claim", () => {
  const claim = decodeNativeInputClaim(
    JSON.stringify({
      version: NATIVE_INPUT_BROKER_VERSION,
      type: "claim",
      nonce: "nonce_native_host",
      token: "token_native_host",
      terminalID: "pane_42",
      paneID: 42,
      kind: "paste",
      byteLength: 42,
    }),
  );
  expect(claim).toMatchObject({
    type: "claim",
    kind: "paste",
    byteLength: 42,
  });
  expect(claim).not.toHaveProperty("data");
  expect(
    nativeInputBrokerDecision({
      event: claim,
      expectedToken: "token_native_host",
      knownPanes: new Map([[42, "terminal_native_host"]]),
    }),
  ).toMatchObject({ permit: true, reason: "accepted" });
});

test("rejects malformed claims and creates platform-private endpoints", () => {
  expect(() => decodeNativeInputClaim('{"type":"input"}')).toThrow("invalid");
  expect(() =>
    decodeNativeInputClaim(
      JSON.stringify({
        version: NATIVE_INPUT_BROKER_VERSION,
        type: "claim",
        nonce: "nonce_mouse",
        token: "token_mouse",
        terminalID: "pane_7",
        paneID: 7,
        kind: "mouse",
        byteLength: 1,
      }),
    ),
  ).toThrow("invalid");
  expect(
    nativeInputBrokerEndpoint({
      runtimeDir: "/run/user/1000",
      daemonID: "daemon_1",
      platform: "linux",
    }),
  ).toBe("/run/user/1000/natalia-native-input-daemon_1.sock");
  expect(
    nativeInputBrokerEndpoint({
      runtimeDir: "ignored",
      daemonID: "daemon_1",
      platform: "win32",
    }),
  ).toBe("\\\\.\\pipe\\natalia-native-input-daemon_1");
});

test("permits only a broker-authenticated mapped terminal", () => {
  const event = decodeNativeInputClaim(
    JSON.stringify({
      version: NATIVE_INPUT_BROKER_VERSION,
      type: "claim",
      nonce: "nonce_2",
      token: "token_2",
      terminalID: "pane_77",
      paneID: 77,
      kind: "keyboard",
      byteLength: 1,
    }),
  );
  expect(
    nativeInputBrokerDecision({
      event,
      expectedToken: "token_2",
      knownPanes: new Map([[77, "terminal_2"]]),
    }),
  ).toMatchObject({ permit: true, reason: "accepted" });
  expect(
    nativeInputBrokerDecision({
      event,
      expectedToken: "wrong",
      knownPanes: new Map([[77, "terminal_2"]]),
    }),
  ).toMatchObject({ permit: false, reason: "denied" });
});

test("uses identical claim wire frames for Unix sockets and Windows pipes", () => {
  const input = {
    version: NATIVE_INPUT_BROKER_VERSION,
    type: "claim" as const,
    nonce: "nonce_cross_platform",
    token: "token_cross_platform",
    terminalID: "pane_7",
    paneID: 7,
    kind: "paste" as const,
    byteLength: 18,
  } as const;
  expect(decodeNativeInputClaim(JSON.stringify(input))).toEqual(input);
  expect(
    nativeInputBrokerEndpoint({
      runtimeDir: "/run/user/1000",
      daemonID: "daemon_cross_platform",
      platform: "darwin",
    }),
  ).toBe("/run/user/1000/natalia-native-input-daemon_cross_platform.sock");
  expect(
    nativeInputBrokerEndpoint({
      runtimeDir: "ignored",
      daemonID: "daemon_cross_platform",
      platform: "win32",
    }),
  ).toBe("\\\\.\\pipe\\natalia-native-input-daemon_cross_platform");
});

test("rejects Unix broker paths that exceed the platform socket limit", () => {
  expect(() =>
    nativeInputBrokerEndpoint({
      runtimeDir: `/run/user/1000/${"deep/".repeat(30)}`,
      daemonID: "daemon_path_limit",
      platform: "linux",
    }),
  ).toThrow("socket path is too long");
});
