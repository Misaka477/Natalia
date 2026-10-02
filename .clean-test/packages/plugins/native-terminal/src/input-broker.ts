export const NATIVE_INPUT_BROKER_VERSION = 2;

export type NativeInputKind = "keyboard" | "ime_commit" | "paste";

/**
 * A native host asks permission before it performs its own original pane write.
 * The broker never receives the input bytes.
 */
export type NativeInputClaim = {
  version: typeof NATIVE_INPUT_BROKER_VERSION;
  type: "claim";
  nonce: string;
  token: string;
  terminalID: string;
  paneID: number;
  kind: NativeInputKind;
  byteLength: number;
};

export type NativeInputDecision = {
  version: typeof NATIVE_INPUT_BROKER_VERSION;
  type: "decision";
  nonce: string;
  permit: boolean;
  reason?: "accepted" | "denied" | "expired" | "invalid";
};

export function decodeNativeInputClaim(frame: string): NativeInputClaim {
  return parse(frame, validateNativeInputClaim);
}

export function encodeNativeInputDecision(decision: NativeInputDecision) {
  validateNativeInputDecision(decision);
  return `${JSON.stringify(decision)}\n`;
}

export function decodeNativeInputDecision(frame: string): NativeInputDecision {
  return parse(frame, validateNativeInputDecision);
}

export function nativeInputBrokerEndpoint(input: {
  runtimeDir: string;
  daemonID: string;
  platform?: NodeJS.Platform;
}) {
  if (!validSegment(input.daemonID))
    throw new Error("native input broker daemon ID is invalid");
  const endpoint =
    (input.platform ?? process.platform) === "win32"
      ? `\\\\.\\pipe\\natalia-native-input-${input.daemonID}`
      : `${input.runtimeDir}/natalia-native-input-${input.daemonID}.sock`;
  if (
    (input.platform ?? process.platform) !== "win32" &&
    endpoint.length >= 104
  )
    throw new Error(
      "native input broker socket path is too long; use a short XDG_RUNTIME_DIR-backed runtime directory",
    );
  return endpoint;
}

export function nativeInputBrokerDecision(input: {
  event: Pick<NativeInputClaim, "nonce" | "token" | "terminalID" | "paneID">;
  expectedToken: string;
  knownPanes: ReadonlyMap<number, string>;
}): NativeInputDecision {
  const permit =
    input.event.token === input.expectedToken &&
    input.event.terminalID === `pane_${input.event.paneID}` &&
    input.knownPanes.has(input.event.paneID);
  return {
    version: NATIVE_INPUT_BROKER_VERSION,
    type: "decision",
    nonce: input.event.nonce,
    permit,
    reason: permit ? "accepted" : "denied",
  };
}

function validateNativeInputClaim(
  value: unknown,
): asserts value is NativeInputClaim {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("native input broker claim must be an object");
  const claim = value as Partial<NativeInputClaim>;
  if (
    claim.version !== NATIVE_INPUT_BROKER_VERSION ||
    claim.type !== "claim" ||
    !validSegment(claim.nonce) ||
    !validSegment(claim.token) ||
    !validSegment(claim.terminalID) ||
    !Number.isSafeInteger(claim.paneID) ||
    !["keyboard", "ime_commit", "paste"].includes(claim.kind ?? "") ||
    !Number.isSafeInteger(claim.byteLength) ||
    (claim.byteLength ?? 0) < 1 ||
    (claim.byteLength ?? 0) > 64 * 1024
  )
    throw new Error("native input broker claim is invalid");
}

function parse<T>(
  frame: string,
  validate: (value: unknown) => asserts value is T,
) {
  let value: unknown;
  try {
    value = JSON.parse(frame) as unknown;
  } catch {
    throw new Error("native input broker frame is not valid JSON");
  }
  validate(value);
  return value;
}

function validateNativeInputDecision(
  value: unknown,
): asserts value is NativeInputDecision {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("native input broker decision must be an object");
  const decision = value as Partial<NativeInputDecision>;
  if (
    decision.version !== NATIVE_INPUT_BROKER_VERSION ||
    decision.type !== "decision" ||
    !validSegment(decision.nonce) ||
    typeof decision.permit !== "boolean" ||
    (decision.reason !== undefined &&
      !["accepted", "denied", "expired", "invalid"].includes(decision.reason))
  )
    throw new Error("native input broker decision is invalid");
}

function validSegment(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/u.test(value);
}
