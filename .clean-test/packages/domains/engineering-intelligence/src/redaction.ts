export function redactToolOutput(output: string, redact: boolean | undefined) {
  if (!redact) return output;
  return output.replace(
    /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s]+/giu,
    (match) =>
      `${match.slice(0, match.indexOf("=") >= 0 ? match.indexOf("=") + 1 : match.indexOf(":") + 1)}[REDACTED]`,
  );
}
