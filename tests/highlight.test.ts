import { describe, it, expect } from "vitest";
import { highlightLine } from "../src/ui/highlight.js";

// ANSI escape codes from the source
const C_KEYWORD = "\x1b[1;35m";
const C_STRING = "\x1b[32m";
const C_COMMENT = "\x1b[2m";
const C_NUMBER = "\x1b[33m";
const C_TYPE = "\x1b[36m";
const C_DEFAULT = "\x1b[32m";
const C_RESET = "\x1b[0m";

describe("highlightLine", () => {
  describe("unknown language", () => {
    it("wraps entire line in default color", () => {
      const result = highlightLine("hello world", "unknown-lang");
      expect(result).toBe(`${C_DEFAULT}hello world${C_RESET}`);
    });
  });

  describe("TypeScript", () => {
    it("highlights keywords", () => {
      const result = highlightLine("const x = 1", "ts");
      expect(result).toContain(`${C_KEYWORD}const${C_RESET}`);
    });

    it("highlights types", () => {
      const result = highlightLine("let x: string", "ts");
      expect(result).toContain(`${C_TYPE}string${C_RESET}`);
    });

    it("highlights string literals", () => {
      const result = highlightLine('const s = "hello"', "ts");
      expect(result).toContain(`${C_STRING}"hello"${C_RESET}`);
    });

    it("highlights numbers", () => {
      const result = highlightLine("const n = 42", "ts");
      expect(result).toContain(`${C_NUMBER}42${C_RESET}`);
    });

    it("highlights line comments", () => {
      const result = highlightLine("// this is a comment", "ts");
      expect(result).toContain(`${C_COMMENT}// this is a comment${C_RESET}`);
    });

    it("handles escaped characters in strings", () => {
      const result = highlightLine('const s = "he\\"llo"', "ts");
      expect(result).toContain(`${C_STRING}"he\\"llo"${C_RESET}`);
    });

    it("handles template literals", () => {
      const result = highlightLine("const s = `hello`", "ts");
      expect(result).toContain(`${C_STRING}\`hello\`${C_RESET}`);
    });
  });

  describe("Python", () => {
    it("highlights Python keywords", () => {
      const result = highlightLine("def foo():", "py");
      expect(result).toContain(`${C_KEYWORD}def${C_RESET}`);
    });

    it("highlights Python types", () => {
      const result = highlightLine("x: int = 5", "py");
      expect(result).toContain(`${C_TYPE}int${C_RESET}`);
    });

    it("highlights # comments", () => {
      const result = highlightLine("# comment", "py");
      expect(result).toContain(`${C_COMMENT}# comment${C_RESET}`);
    });
  });

  describe("Rust", () => {
    it("highlights Rust keywords", () => {
      const result = highlightLine("fn main() {", "rust");
      expect(result).toContain(`${C_KEYWORD}fn${C_RESET}`);
    });

    it("highlights Rust types", () => {
      const result = highlightLine("let x: i32 = 0;", "rust");
      expect(result).toContain(`${C_TYPE}i32${C_RESET}`);
    });
  });

  describe("Go", () => {
    it("highlights Go keywords", () => {
      const result = highlightLine("func main() {", "go");
      expect(result).toContain(`${C_KEYWORD}func${C_RESET}`);
    });
  });

  describe("Bash", () => {
    it("highlights bash keywords", () => {
      const result = highlightLine("if [ -f file ]; then", "bash");
      expect(result).toContain(`${C_KEYWORD}if${C_RESET}`);
      expect(result).toContain(`${C_KEYWORD}then${C_RESET}`);
    });
  });

  describe("JSON", () => {
    it("highlights string keys", () => {
      const result = highlightLine('"key": "value"', "json");
      expect(result).toContain(`${C_STRING}"key"${C_RESET}`);
      expect(result).toContain(`${C_STRING}"value"${C_RESET}`);
    });

    it("highlights boolean values", () => {
      const result = highlightLine('"ok": true', "json");
      expect(result).toContain(`${C_TYPE}true${C_RESET}`);
    });
  });

  describe("language aliases", () => {
    it("tsx maps to TypeScript", () => {
      const result = highlightLine("const x = 1", "tsx");
      expect(result).toContain(`${C_KEYWORD}const${C_RESET}`);
    });

    it("sh maps to bash", () => {
      const result = highlightLine("if true; then", "sh");
      expect(result).toContain(`${C_KEYWORD}if${C_RESET}`);
    });

    it("golang maps to go", () => {
      const result = highlightLine("func main() {", "golang");
      expect(result).toContain(`${C_KEYWORD}func${C_RESET}`);
    });
  });

  describe("HTML", () => {
    it("highlights tags", () => {
      const result = highlightLine("<div>hello</div>", "html");
      expect(result).toContain(`${C_TYPE}<div${C_RESET}`);
      expect(result).toContain(`${C_TYPE}</div${C_RESET}`);
    });

    it("highlights attribute values", () => {
      const result = highlightLine('<a href="url">', "html");
      expect(result).toContain(`${C_STRING}"url"${C_RESET}`);
    });

    it("highlights comments (closing > captured by tag regex)", () => {
      // Known: highlightHTML applies regexes sequentially, so the closing >
      // in --> gets matched by the closing-tag regex before the comment regex.
      const result = highlightLine("<!-- comment -->", "html");
      // The comment body is present, but > is colored as tag
      expect(result).toContain("<!-- comment --");
      expect(result).toContain(`${C_TYPE}>${C_RESET}`);
    });

    it("highlights self-closing tags", () => {
      const result = highlightLine('<img src="x" />', "html");
      expect(result).toContain(`${C_TYPE}<img${C_RESET}`);
    });

    it("highlights closing >", () => {
      const result = highlightLine("<br>", "html");
      expect(result).toContain(`${C_TYPE}>${C_RESET}`);
    });
  });

  describe("edge cases", () => {
    it("handles empty line", () => {
      const result = highlightLine("", "ts");
      expect(result).toBe("");
    });

    it("handles unterminated string", () => {
      const result = highlightLine('const s = "unterminated', "ts");
      expect(result).toContain(`${C_STRING}"unterminated${C_RESET}`);
    });
  });
});
