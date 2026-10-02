// A `.txt` prompt file imported as its raw string content (Bun inlines it at
// build time). Declared so TypeScript accepts `import X from "./file.txt"`.
declare module "*.txt" {
  const content: string;
  export default content;
}
