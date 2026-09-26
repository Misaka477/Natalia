import {
  mkdirSync,
  rmSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";

const repo = resolve(process.cwd());
const diffWasm = join(repo, "packages/framework/diff-wasm");
const srcLib = join(diffWasm, "src/lib.rs");
const srcAstDiff = join(diffWasm, "src/ast_diff.rs");
const outDir = join(diffWasm, "ast");

type Lang = {
  id: string;
  crate: string;
  version: string;
  constExpr: string;
};

const LANGUAGES: Lang[] = [
  {
    id: "javascript",
    crate: "tree-sitter-javascript",
    version: "0.25.0",
    constExpr: "tree_sitter_javascript::LANGUAGE",
  },
  {
    id: "typescript",
    crate: "tree-sitter-typescript",
    version: "0.23.2",
    constExpr: "tree_sitter_typescript::LANGUAGE_TYPESCRIPT",
  },
  {
    id: "tsx",
    crate: "tree-sitter-typescript",
    version: "0.23.2",
    constExpr: "tree_sitter_typescript::LANGUAGE_TSX",
  },
  {
    id: "python",
    crate: "tree-sitter-python",
    version: "0.25.0",
    constExpr: "tree_sitter_python::LANGUAGE",
  },
  {
    id: "go",
    crate: "tree-sitter-go",
    version: "0.25.0",
    constExpr: "tree_sitter_go::LANGUAGE",
  },
  {
    id: "rust",
    crate: "tree-sitter-rust-orchard",
    version: "0.16.6",
    constExpr: "tree_sitter_rust_orchard::LANGUAGE",
  },
  {
    id: "json",
    crate: "tree-sitter-json",
    version: "0.24.8",
    constExpr: "tree_sitter_json::LANGUAGE",
  },
  {
    id: "c",
    crate: "tree-sitter-c",
    version: "0.24",
    constExpr: "tree_sitter_c::LANGUAGE",
  },
  {
    id: "cpp",
    crate: "tree-sitter-cpp",
    version: "0.23.4",
    constExpr: "tree_sitter_cpp::LANGUAGE",
  },
  {
    id: "java",
    crate: "tree-sitter-java-orchard",
    version: "0.5.9",
    constExpr: "tree_sitter_java_orchard::LANGUAGE",
  },
  {
    id: "csharp",
    crate: "tree-sitter-c-sharp",
    version: "0.23.1",
    constExpr: "tree_sitter_c_sharp::LANGUAGE",
  },
  {
    id: "bash",
    crate: "tree-sitter-bash",
    version: "0.25.1",
    constExpr: "tree_sitter_bash::LANGUAGE",
  },
  {
    id: "ruby",
    crate: "tree-sitter-ruby",
    version: "0.23.1",
    constExpr: "tree_sitter_ruby::LANGUAGE",
  },
  {
    id: "php",
    crate: "tree-sitter-php",
    version: "0.24.0",
    constExpr: "tree_sitter_php::LANGUAGE_PHP",
  },
  {
    id: "css",
    crate: "tree-sitter-css",
    version: "0.25.0",
    constExpr: "tree_sitter_css::LANGUAGE",
  },
  {
    id: "yaml",
    crate: "tree-sitter-yaml",
    version: "0.7.0",
    constExpr: "tree_sitter_yaml::LANGUAGE",
  },
  {
    id: "xml",
    crate: "tree-sitter-xml",
    version: "0.7.0",
    constExpr: "tree_sitter_xml::LANGUAGE_XML",
  },
  {
    id: "lua",
    crate: "tree-sitter-lua",
    version: "0.5",
    constExpr: "tree_sitter_lua::LANGUAGE",
  },
  {
    id: "scala",
    crate: "tree-sitter-scala",
    version: "0.26.2",
    constExpr: "tree_sitter_scala::LANGUAGE",
  },
  {
    id: "swift",
    crate: "tree-sitter-swift",
    version: "0.7.1",
    constExpr: "tree_sitter_swift::LANGUAGE",
  },
  {
    id: "elixir",
    crate: "tree-sitter-elixir",
    version: "0.3.4",
    constExpr: "tree_sitter_elixir::LANGUAGE",
  },
  {
    id: "haskell",
    crate: "tree-sitter-haskell",
    version: "0.23.1",
    constExpr: "tree_sitter_haskell::LANGUAGE",
  },
  {
    id: "nix",
    crate: "tree-sitter-nix",
    version: "0.3.0",
    constExpr: "tree_sitter_nix::LANGUAGE",
  },
  {
    id: "zig",
    crate: "tree-sitter-zig",
    version: "1.1.2",
    constExpr: "tree_sitter_zig::LANGUAGE",
  },
  {
    id: "elm",
    crate: "tree-sitter-elm",
    version: "5.8.0",
    constExpr: "tree_sitter_elm::LANGUAGE",
  },
  {
    id: "fsharp",
    crate: "tree-sitter-fsharp",
    version: "0.3.0",
    constExpr: "tree_sitter_fsharp::LANGUAGE_FSHARP",
  },
  {
    id: "ocaml",
    crate: "tree-sitter-ocaml",
    version: "0.25.0",
    constExpr: "tree_sitter_ocaml::LANGUAGE_OCAML",
  },
  {
    id: "r",
    crate: "tree-sitter-r",
    version: "1.2.0",
    constExpr: "tree_sitter_r::LANGUAGE",
  },
  {
    id: "julia",
    crate: "tree-sitter-julia",
    version: "0.23.1",
    constExpr: "tree_sitter_julia::LANGUAGE",
  },
  {
    id: "dart",
    crate: "tree-sitter-dart-orchard",
    version: "0.5.0",
    constExpr: "tree_sitter_dart_orchard::LANGUAGE",
  },
  {
    id: "clojure",
    crate: "tree-sitter-clojure-orchard",
    version: "0.2.5",
    constExpr: "tree_sitter_clojure_orchard::LANGUAGE",
  },
  {
    id: "toml",
    crate: "tree-sitter-toml-ng",
    version: "0.7.0",
    constExpr: "tree_sitter_toml_ng::LANGUAGE",
  },
  {
    id: "sql",
    crate: "tree-sitter-sequel",
    version: "0.3.11",
    constExpr: "tree_sitter_sequel::LANGUAGE",
  },
  {
    id: "cmake",
    crate: "tree-sitter-cmake",
    version: "0.7.1",
    constExpr: "tree_sitter_cmake::LANGUAGE",
  },
  {
    id: "fish",
    crate: "tree-sitter-fish",
    version: "3.6.0",
    constExpr: "tree_sitter_fish::language()",
  },
  {
    id: "make",
    crate: "tree-sitter-make",
    version: "1.1.1",
    constExpr: "tree_sitter_make::LANGUAGE",
  },
  {
    id: "perl",
    crate: "ts-parser-perl",
    version: "1.2.0",
    constExpr: "ts_parser_perl::LANGUAGE",
  },
  {
    id: "proto",
    crate: "tree-sitter-proto",
    version: "0.4.0",
    constExpr: "tree_sitter_proto::LANGUAGE",
  },
  {
    id: "racket",
    crate: "tree-sitter-racket",
    version: "0.24.7",
    constExpr: "tree_sitter_racket::LANGUAGE",
  },
  {
    id: "scheme",
    crate: "tree-sitter-scheme",
    version: "0.24.7",
    constExpr: "tree_sitter_scheme::LANGUAGE",
  },
  {
    id: "verilog",
    crate: "tree-sitter-verilog",
    version: "1.0.3",
    constExpr: "tree_sitter_verilog::LANGUAGE",
  },
  {
    id: "vhdl",
    crate: "tree-sitter-vhdl",
    version: "1.4.0",
    constExpr: "tree_sitter_vhdl::LANGUAGE",
  },
  {
    id: "pascal",
    crate: "tree-sitter-pascal",
    version: "0.10.0",
    constExpr: "tree_sitter_pascal::LANGUAGE",
  },
  {
    id: "objc",
    crate: "tree-sitter-objc",
    version: "3.0.2",
    constExpr: "tree_sitter_objc::LANGUAGE",
  },
];

const baseCargo = (extraDep: string) => `[package]
name = "natalia-ast-wasm"
version = "0.1.0"
edition = "2021"
license = "Apache-2.0"

[lib]
crate-type = ["cdylib"]

[dependencies]
imara-diff = "0.2.0"
tree-sitter = "=0.26.10"
tree-sitter-language = "=0.1.7"
${extraDep}
memchr = "=2.8.1"
`;

mkdirSync(outDir, { recursive: true });

let built = 0;
for (const lang of LANGUAGES) {
  const id = lang.id;
  const out = join(outDir, `${id}.wasm`);
  if (process.env.SKIP_EXISTING !== "1" && existsSync(out)) {
    console.log(`skip ${id}`);
    built += 1;
    continue;
  }
  const dir = join("/tmp", `ast-pack-${id}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  const dep = `${lang.crate} = "${lang.version}"`;
  writeFileSync(join(dir, "Cargo.toml"), baseCargo(dep));
  writeFileSync(join(dir, "src/ast_diff.rs"), readFileSync(srcAstDiff, "utf8"));
  writeFileSync(join(dir, "src/lib.rs"), readFileSync(srcLib, "utf8"));
  writeFileSync(
    join(dir, "src/ast_langs.rs"),
    `use tree_sitter::Language;

pub fn grammar(language_id: &str) -> Option<Language> {
    match language_id {
        "${id}" => Some(${lang.constExpr}.into()),
        _ => None,
    }
}
`,
  );
  const env = {
    ...process.env,
    WASI_SDK: "/opt/wasi-sdk",
    CC: "/opt/wasi-sdk/bin/clang",
    CFLAGS: "--target=wasm32-wasip1",
    CARGO_HOME: "/tmp/cargo-diff-home",
    CARGO_TARGET_DIR: `/tmp/ast-pack-target/${id}`,
  };
  try {
    execFileSync("cargo", ["build", "--release", "--target", "wasm32-wasip1"], {
      cwd: dir,
      env,
      stdio: "pipe",
    });
    const wasm = join(
      env.CARGO_TARGET_DIR!,
      "wasm32-wasip1/release/natalia_ast_wasm.wasm",
    );
    copyFileSync(wasm, out);
    built += 1;
    console.log(
      `built ${id} ${(statSync(out).size / 1024 / 1024).toFixed(1)}MB`,
    );
  } catch (error) {
    // Fail LOUD, not best-effort: a silently missing pack means the AST
    // face parses nothing and the tests fail with a phantom "no move
    // detected" — the CI lesson. A release whose parser is absent is a
    // lie; a green step that produced zero packs is the same lie.
    console.error(`failed ${id}: ${String(error)}`);
    process.exitCode = 1;
  }
}
// The gate: every language present, or the run is red. A partial pack set
// parses some languages and silently fails others — the AST face would
// answer "no move detected" for a language whose pack is missing.
console.log(
  `ast packs: ${built}/${LANGUAGES.length} present (${LANGUAGES.length - built} missing)`,
);
if (built !== LANGUAGES.length) process.exitCode = 1;
