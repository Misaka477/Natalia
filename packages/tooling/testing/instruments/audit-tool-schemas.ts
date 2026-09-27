/**
 * Static tool-schema audit.
 *
 * Every inline `parameters` or `output.schema` literal in shipped TypeScript is
 * checked recursively:
 *   - `type: "array"` must carry `items`;
 *   - `type: "object"` must carry `properties`;
 *   - `enum` must be a non-empty array, and must be spread from a named
 *     constant rather than written as an inline literal list.
 *
 * Dynamic schemas (variables, MCP-provided inputSchema) are intentionally
 * outside this static pass; the runtime contract still validates them.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import ts from "typescript";

const root = process.cwd();
const sourceRoots = ["packages", "apps"];
const skippedDirectories = new Set([
  ".git",
  ".kilo",
  "dist",
  "node_modules",
  "target",
  "test",
  "tests",
]);

type Finding = { file: string; line: number; message: string };

async function* walk(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (skippedDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile() && path.endsWith(".ts")) yield path;
  }
}

function lineOf(sourceFile: ts.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function propertyName(node: ts.ObjectLiteralElementLike): string | undefined {
  if (!ts.isPropertyAssignment(node)) return undefined;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
    return node.name.text;
  return undefined;
}

function property(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  return object.properties.find(
    (candidate) => propertyName(candidate) === name,
  ) as ts.PropertyAssignment | undefined;
}

function stringValue(node: ts.Expression | undefined): string | undefined {
  return node && ts.isStringLiteral(node) ? node.text : undefined;
}

function isSchemaLike(object: ts.ObjectLiteralExpression): boolean {
  return ["type", "properties", "items", "enum"].some(
    (name) => property(object, name) !== undefined,
  );
}

function isLiteral(
  node: ts.Expression,
): node is
  | ts.StringLiteral
  | ts.NumericLiteral
  | ts.TrueLiteral
  | ts.FalseLiteral
  | ts.NullLiteral {
  return (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
}

function auditSchemaObject(
  object: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
  file: string,
  findings: Finding[],
): void {
  const type = stringValue(property(object, "type")?.initializer);
  if (type === "array" && !property(object, "items"))
    findings.push({
      file,
      line: lineOf(sourceFile, object.getStart(sourceFile)),
      message: 'schema has type:"array" without items',
    });
  if (type === "object" && !property(object, "properties"))
    findings.push({
      file,
      line: lineOf(sourceFile, object.getStart(sourceFile)),
      message: 'schema has type:"object" without properties',
    });

  const enumProperty = property(object, "enum");
  if (enumProperty) {
    const value = enumProperty.initializer;
    if (!ts.isArrayLiteralExpression(value) || value.elements.length === 0)
      findings.push({
        file,
        line: lineOf(sourceFile, value.getStart(sourceFile)),
        message: "enum must be a non-empty array",
      });
    else if (value.elements.every((element) => isLiteral(element)))
      findings.push({
        file,
        line: lineOf(sourceFile, value.getStart(sourceFile)),
        message:
          "enum is an inline literal list; spread a named exported constant instead",
      });
  }

  const items = property(object, "items")?.initializer;
  if (items && ts.isObjectLiteralExpression(items) && isSchemaLike(items))
    auditSchemaObject(items, sourceFile, file, findings);
  if (items && ts.isArrayLiteralExpression(items)) {
    for (const element of items.elements)
      if (ts.isObjectLiteralExpression(element) && isSchemaLike(element))
        auditSchemaObject(element, sourceFile, file, findings);
  }

  const properties = property(object, "properties")?.initializer;
  if (properties && ts.isObjectLiteralExpression(properties)) {
    for (const entry of properties.properties) {
      if (!ts.isPropertyAssignment(entry)) continue;
      const value = entry.initializer;
      if (ts.isObjectLiteralExpression(value) && isSchemaLike(value))
        auditSchemaObject(value, sourceFile, file, findings);
    }
  }

  const additionalProperties = property(
    object,
    "additionalProperties",
  )?.initializer;
  if (
    additionalProperties &&
    ts.isObjectLiteralExpression(additionalProperties) &&
    isSchemaLike(additionalProperties)
  )
    auditSchemaObject(additionalProperties, sourceFile, file, findings);
}

function auditSourceFile(
  sourceFile: ts.SourceFile,
  file: string,
  findings: Finding[],
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node);
      if (
        (name === "parameters" || name === "schema") &&
        ts.isObjectLiteralExpression(node.initializer) &&
        isSchemaLike(node.initializer)
      )
        auditSchemaObject(node.initializer, sourceFile, file, findings);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

async function main(): Promise<void> {
  const files: string[] = [];
  for (const sourceRoot of sourceRoots) {
    try {
      for await (const file of walk(join(root, sourceRoot))) files.push(file);
    } catch {
      // A source root may be absent in a trimmed checkout; the other roots
      // still get audited.
    }
  }

  const findings: Finding[] = [];
  for (const file of files) {
    const sourceFile = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    auditSourceFile(sourceFile, relative(root, file), findings);
  }

  if (!findings.length) {
    console.log(
      `tool schema audit: ${files.length} shipped TypeScript files clean`,
    );
    return;
  }
  for (const finding of findings)
    console.error(`${finding.file}:${finding.line}: ${finding.message}`);
  process.exitCode = 1;
}

await main();
