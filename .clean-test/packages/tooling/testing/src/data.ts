export function makeDigest(input: string) {
  return new Bun.CryptoHasher("sha256").update(input).digest("hex");
}

export function lineCount(input: string) {
  return input.length === 0 ? 1 : input.split("\n").length;
}

export function chinese300() {
  return "中".repeat(300);
}

export function chinese10000() {
  return "界".repeat(10_000);
}

export function mixedGraphemes(count = 20_000) {
  const unit = ["A", "中", "🙂", "e\u0301", "，", "क्‍ष"].join("");
  return unit.repeat(Math.ceil(count / 6));
}

export function paste100KiB() {
  const unit = "日志行: 中文 emoji 🙂 e\u0301 ASCII 1234567890\n";
  return unit.repeat(
    Math.ceil((100 * 1024) / new TextEncoder().encode(unit).byteLength),
  );
}

export function paste1MiB() {
  const unit = "混合 grapheme e\u0301 🙂 全角，ASCII 1234567890\n";
  return unit.repeat(
    Math.ceil((1024 * 1024) / new TextEncoder().encode(unit).byteLength),
  );
}
