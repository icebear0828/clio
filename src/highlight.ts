interface LangDef {
  keywords: Set<string>;
  types: Set<string>;
  lineComment: string;
  stringDelims: string[];
}

const S = (s: string) => new Set(s.split(" "));

const tsLang: LangDef = {
  keywords: S("const let var function class if else for while return import export async await new this throw try catch switch case break continue default void typeof instanceof of in yield delete from extends implements"),
  types: S("string number boolean void unknown never null undefined bigint symbol"),
  lineComment: "//",
  stringDelims: ['"', "'", "`"],
};

const pyLang: LangDef = {
  keywords: S("def class if elif else for while return import from as try except finally with raise pass break continue lambda yield async await and or not in is del global nonlocal"),
  types: S("int float str bool list dict set tuple None True False bytes range type object"),
  lineComment: "#",
  stringDelims: ['"', "'"],
};

const rustLang: LangDef = {
  keywords: S("fn let mut const struct enum impl trait pub use mod if else for while loop match return async await move self super crate where unsafe static ref type as in"),
  types: S("i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 bool char String Vec Option Result Box Rc Arc Self usize isize"),
  lineComment: "//",
  stringDelims: ['"'],
};

const goLang: LangDef = {
  keywords: S("func var const type struct interface if else for range return import package defer go select switch case break continue map chan fallthrough goto"),
  types: S("int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float32 float64 complex64 complex128 string bool byte rune error nil true false uintptr"),
  lineComment: "//",
  stringDelims: ['"', "'", "`"],
};

const bashLang: LangDef = {
  keywords: S("if then else elif fi for while do done case esac function return local export echo exit in select until"),
  types: S("true false"),
  lineComment: "#",
  stringDelims: ['"', "'"],
};

const jsonLang: LangDef = {
  keywords: new Set<string>(),
  types: S("true false null"),
  lineComment: "",
  stringDelims: ['"'],
};

const cssLang: LangDef = {
  keywords: S("import media keyframes font-face charset supports layer container"),
  types: S("none auto inherit initial unset transparent currentColor"),
  lineComment: "",
  stringDelims: ['"', "'"],
};

const htmlLang: LangDef = {
  keywords: new Set<string>(),
  types: new Set<string>(),
  lineComment: "",
  stringDelims: ['"', "'"],
};

const LANG_MAP: Record<string, LangDef> = {
  typescript: tsLang, ts: tsLang,
  javascript: tsLang, js: tsLang, jsx: tsLang, tsx: tsLang,
  python: pyLang, py: pyLang,
  rust: rustLang, rs: rustLang,
  go: goLang, golang: goLang,
  bash: bashLang, sh: bashLang, shell: bashLang, zsh: bashLang,
  json: jsonLang, jsonc: jsonLang,
  css: cssLang, scss: cssLang, less: cssLang,
  html: htmlLang, xml: htmlLang, svg: htmlLang,
};

// ANSI codes — direct sequences, not using render.ts esc() to avoid reset nesting
const C_KEYWORD  = "\x1b[1;35m"; // bold magenta
const C_STRING   = "\x1b[32m";   // green
const C_COMMENT  = "\x1b[2m";    // dim
const C_NUMBER   = "\x1b[33m";   // yellow
const C_TYPE     = "\x1b[36m";   // cyan
const C_DEFAULT  = "\x1b[32m";   // green (code block base color)
const C_RESET    = "\x1b[0m";

const RE_NUMBER = /^\b\d[\d_.]*(?:e[+-]?\d+)?\b/i;
const RE_WORD = /^[a-zA-Z_$][\w$]*/;
const RE_OP = /^[+\-*/%=!<>&|^~?:;,.{}()[\]@#]+/;

export function highlightLine(line: string, lang: string): string {
  const def = LANG_MAP[lang];
  if (!def) return `${C_DEFAULT}${line}${C_RESET}`;

  // HTML/XML: simple tag-aware highlighting
  if (lang === "html" || lang === "xml" || lang === "svg") {
    return highlightHTML(line);
  }

  let pos = 0;
  let out = "";
  const len = line.length;

  while (pos < len) {
    // Line comment
    if (def.lineComment && line.startsWith(def.lineComment, pos)) {
      out += `${C_COMMENT}${line.slice(pos)}${C_RESET}`;
      return out;
    }

    // String literals
    let matched = false;
    for (const delim of def.stringDelims) {
      if (line[pos] === delim) {
        const end = findStringEnd(line, pos, delim);
        out += `${C_STRING}${line.slice(pos, end)}${C_RESET}`;
        pos = end;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Numbers
    const numMatch = line.slice(pos).match(RE_NUMBER);
    if (numMatch && (pos === 0 || /\W/.test(line[pos - 1]))) {
      out += `${C_NUMBER}${numMatch[0]}${C_RESET}`;
      pos += numMatch[0].length;
      continue;
    }

    // Words (keywords, types, identifiers)
    const wordMatch = line.slice(pos).match(RE_WORD);
    if (wordMatch) {
      const word = wordMatch[0];
      if (def.keywords.has(word)) {
        out += `${C_KEYWORD}${word}${C_RESET}`;
      } else if (def.types.has(word)) {
        out += `${C_TYPE}${word}${C_RESET}`;
      } else {
        out += `${C_DEFAULT}${word}${C_RESET}`;
      }
      pos += word.length;
      continue;
    }

    // Operators
    const opMatch = line.slice(pos).match(RE_OP);
    if (opMatch) {
      out += `${C_COMMENT}${opMatch[0]}${C_RESET}`;
      pos += opMatch[0].length;
      continue;
    }

    // Default: whitespace or other
    out += `${C_DEFAULT}${line[pos]}${C_RESET}`;
    pos++;
  }

  return out;
}

function findStringEnd(line: string, start: number, delim: string): number {
  let pos = start + 1;
  while (pos < line.length) {
    if (line[pos] === "\\" && pos + 1 < line.length) {
      pos += 2;
      continue;
    }
    if (line[pos] === delim) return pos + 1;
    pos++;
  }
  return line.length; // unterminated string
}

function highlightHTML(line: string): string {
  // Simple regex-based HTML highlighting
  let out = line;
  // Tags: <tagname ... > and </tagname>
  out = out.replace(/<\/?([a-zA-Z][\w-]*)/g, (m, tag: string) =>
    `${C_TYPE}${m}${C_RESET}`
  );
  // Attribute values (strings)
  out = out.replace(/=("[^"]*"|'[^']*')/g, (m, val: string) =>
    `=${C_STRING}${val}${C_RESET}`
  );
  // Closing >
  out = out.replace(/(?<!=["'])\/?>/g, (m) => `${C_TYPE}${m}${C_RESET}`);
  // Comments
  out = out.replace(/<!--[\s\S]*?-->/g, (m) => `${C_COMMENT}${m}${C_RESET}`);
  return out;
}
