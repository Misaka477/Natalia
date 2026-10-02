import type { ToolSchema } from "./index";

export type ToolParameterError = {
  path: string;
  message: string;
};

type JsonSchemaLike = Record<string, unknown>;

function joinPath(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

export function validateToolParameters(
  schema: ToolSchema,
  input: unknown,
): ToolParameterError[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return [{ path: "", message: "expected an object" }];
  }
  return validateObject(
    schema as unknown as JsonSchemaLike,
    input as Record<string, unknown>,
    "",
  );
}

function validateObject(
  schema: JsonSchemaLike,
  value: Record<string, unknown>,
  prefix: string,
): ToolParameterError[] {
  const errors: ToolParameterError[] = [];
  const properties = (schema.properties ?? {}) as Record<string, unknown>;

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties))
        errors.push({
          path: joinPath(prefix, key),
          message: `unexpected property "${key}"`,
        });
    }
  }

  for (const key of (schema.required as string[] | undefined) ?? []) {
    if (!(key in value))
      errors.push({
        path: joinPath(prefix, key),
        message: `missing required property "${key}"`,
      });
  }

  for (const [key, raw] of Object.entries(properties)) {
    if (!(key in value)) continue;
    errors.push(
      ...validateValue(
        raw as JsonSchemaLike,
        value[key],
        joinPath(prefix, key),
      ),
    );
  }
  return errors;
}

/** Recursively validates a value, so `items`/`properties` errors carry a path. */
function validateValue(
  schema: JsonSchemaLike,
  value: unknown,
  path: string,
): ToolParameterError[] {
  const type = schema.type as string | undefined;
  if (!type) return [];

  if (type === "string") {
    if (typeof value !== "string")
      return [{ path, message: `expected string, got ${typeof value}` }];
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      return [{ path, message: `string too short (min ${schema.minLength})` }];
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      return [{ path, message: `string too long (max ${schema.maxLength})` }];
    if (
      Array.isArray(schema.enum) &&
      !(schema.enum as string[]).includes(value)
    )
      return [
        {
          path,
          message: `expected one of: ${(schema.enum as string[]).join(", ")}`,
        },
      ];
    return [];
  }

  if (type === "number" || type === "integer") {
    if (
      typeof value !== "number" ||
      (type === "integer" && !Number.isInteger(value))
    )
      return [
        {
          path,
          message: `expected ${type}, got ${typeof value}${typeof value === "number" ? " (non-integer)" : ""}`,
        },
      ];
    if (typeof schema.minimum === "number" && value < schema.minimum)
      return [{ path, message: `must be at least ${schema.minimum}` }];
    if (typeof schema.maximum === "number" && value > schema.maximum)
      return [{ path, message: `must be at most ${schema.maximum}` }];
    return [];
  }

  if (type === "boolean")
    return typeof value === "boolean"
      ? []
      : [{ path, message: `expected boolean, got ${typeof value}` }];

  if (type === "array") {
    if (!Array.isArray(value))
      return [{ path, message: `expected array, got ${typeof value}` }];
    const errors: ToolParameterError[] = [];
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      errors.push({
        path,
        message: `array too short (min ${schema.minItems})`,
      });
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      errors.push({ path, message: `array too long (max ${schema.maxItems})` });
    const items = schema.items as JsonSchemaLike | undefined;
    if (items)
      for (let index = 0; index < value.length; index += 1)
        errors.push(...validateValue(items, value[index], `${path}[${index}]`));
    return errors;
  }

  if (type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return [{ path, message: `expected object, got ${typeof value}` }];
    return validateObject(schema, value as Record<string, unknown>, path);
  }

  if (type === "null")
    return value === null ? [] : [{ path, message: "expected null" }];

  return [];
}

export function assertValidToolParameters(
  schema: ToolSchema,
  input: unknown,
): void {
  const errors = validateToolParameters(schema, input);
  if (errors.length) {
    const detail = errors
      .map((e) => `${e.path || "(root)"}: ${e.message}`)
      .join("; ");
    throw new Error(`tool parameter validation failed: ${detail}`);
  }
}

/**
 * Validate a tool's output against the shape it declared.
 *
 * A tool's `execute` returns the model-facing string, not a value, so the
 * declared schema is a contract only for the tools whose result is JSON. The
 * check runs on that subset and skips everything else rather than forcing every
 * text-returning tool to wrap its output.
 *
 * A tool whose JSON has drifted from what it declared fails here, with the
 * exact paths, instead of handing the model a shape it was told to expect
 * differently — and the caller turns that into a normal tool failure.
 */
export function validateToolOutput(
  schema: ToolSchema,
  output: string,
): ToolParameterError[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    // Not JSON: the schema describes a JSON result this call did not produce.
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return [];
  return validateObject(
    schema as unknown as JsonSchemaLike,
    parsed as Record<string, unknown>,
    "value",
  );
}
