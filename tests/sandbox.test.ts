import { describe, it, expect, beforeEach } from "vitest";
import { Sandbox, type SandboxConfig } from "../src/core/sandbox.js";
import * as path from "node:path";
import * as os from "node:os";

const CWD = process.platform === "win32" ? "D:\\project" : "/home/user/project";

function makeSandbox(config: SandboxConfig): Sandbox {
  return new Sandbox(config, CWD);
}

describe("Sandbox", () => {
  describe("assertPathAllowed", () => {
    it("allows paths within cwd", () => {
      const sb = makeSandbox({});
      expect(() => sb.assertPathAllowed(path.join(CWD, "src", "index.ts"), "read")).not.toThrow();
      expect(() => sb.assertPathAllowed(path.join(CWD, "src", "index.ts"), "write")).not.toThrow();
    });

    it("allows cwd itself", () => {
      const sb = makeSandbox({});
      expect(() => sb.assertPathAllowed(CWD, "read")).not.toThrow();
    });

    it("rejects paths outside cwd", () => {
      const sb = makeSandbox({});
      const outside = process.platform === "win32" ? "D:\\other\\file.ts" : "/etc/passwd";
      expect(() => sb.assertPathAllowed(outside, "read")).toThrow(/outside workspace/);
    });

    it("allows explicitly allowed paths outside cwd", () => {
      const allowedDir = process.platform === "win32" ? "D:\\shared" : "/tmp/shared";
      const sb = makeSandbox({ filesystem: { allowedPaths: [allowedDir] } });
      expect(() => sb.assertPathAllowed(path.join(allowedDir, "file.txt"), "read")).not.toThrow();
    });

    it("denies explicitly denied paths even within cwd", () => {
      const deniedDir = path.join(CWD, ".env");
      const sb = makeSandbox({ filesystem: { deniedPaths: [deniedDir] } });
      expect(() => sb.assertPathAllowed(deniedDir, "read")).toThrow(/denied/);
    });

    it("denies write to read-only paths", () => {
      const roDir = path.join(CWD, "vendor");
      const sb = makeSandbox({ filesystem: { readOnlyPaths: [roDir] } });
      expect(() => sb.assertPathAllowed(path.join(roDir, "lib.js"), "read")).not.toThrow();
      expect(() => sb.assertPathAllowed(path.join(roDir, "lib.js"), "write")).toThrow(/read-only/);
    });

    it("denied takes priority over allowed", () => {
      const dir = process.platform === "win32" ? "D:\\shared" : "/tmp/shared";
      const sb = makeSandbox({
        filesystem: {
          allowedPaths: [dir],
          deniedPaths: [path.join(dir, "secret")],
        },
      });
      expect(() => sb.assertPathAllowed(path.join(dir, "ok.txt"), "read")).not.toThrow();
      expect(() => sb.assertPathAllowed(path.join(dir, "secret", "key"), "read")).toThrow(/denied/);
    });

    it("expands ~ in config paths", () => {
      const sb = makeSandbox({ filesystem: { allowedPaths: ["~/Documents"] } });
      const homeDoc = path.join(os.homedir(), "Documents", "file.txt");
      expect(() => sb.assertPathAllowed(homeDoc, "read")).not.toThrow();
    });
  });

  describe("buildEnvironment", () => {
    it("blocks default sensitive env vars in blacklist mode", () => {
      const origEnv = process.env;
      process.env = { ...origEnv, PATH: "/usr/bin", AWS_SECRET_ACCESS_KEY: "secret123", HOME: "/home/user" };
      try {
        const sb = makeSandbox({});
        const env = sb.buildEnvironment();
        expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
        expect(env).toHaveProperty("PATH");
        expect(env).toHaveProperty("HOME");
      } finally {
        process.env = origEnv;
      }
    });

    it("blocks custom env vars", () => {
      const origEnv = process.env;
      process.env = { ...origEnv, PATH: "/usr/bin", MY_SECRET: "value" };
      try {
        const sb = makeSandbox({ environment: { block: ["MY_SECRET"] } });
        const env = sb.buildEnvironment();
        expect(env).not.toHaveProperty("MY_SECRET");
      } finally {
        process.env = origEnv;
      }
    });

    it("passthrough (whitelist) mode only passes listed vars", () => {
      const origEnv = process.env;
      process.env = { PATH: "/usr/bin", HOME: "/home/user", CUSTOM: "val", SECRET: "hide" };
      try {
        const sb = makeSandbox({ environment: { passthrough: ["CUSTOM"] } });
        const env = sb.buildEnvironment();
        expect(env).toHaveProperty("PATH"); // essential
        expect(env).toHaveProperty("CUSTOM");
        expect(env).not.toHaveProperty("SECRET");
      } finally {
        process.env = origEnv;
      }
    });

    it("applies overrides", () => {
      const sb = makeSandbox({ environment: { override: { NODE_ENV: "sandbox" } } });
      const env = sb.buildEnvironment();
      expect(env.NODE_ENV).toBe("sandbox");
    });

    it("includes extra vars", () => {
      const sb = makeSandbox({});
      const env = sb.buildEnvironment({ HOOK_VAR: "test" });
      expect(env.HOOK_VAR).toBe("test");
    });
  });

  describe("validateCommand", () => {
    it("allows all commands when network enabled (default)", () => {
      const sb = makeSandbox({});
      expect(sb.validateCommand("curl https://example.com")).toEqual({ allowed: true });
    });

    it("blocks network commands when network disabled", () => {
      const sb = makeSandbox({ network: { enabled: false } });
      expect(sb.validateCommand("curl https://example.com").allowed).toBe(false);
      expect(sb.validateCommand("wget file.zip").allowed).toBe(false);
      expect(sb.validateCommand("ssh user@host").allowed).toBe(false);
      expect(sb.validateCommand("nc -l 8080").allowed).toBe(false);
    });

    it("allows non-network commands when network disabled", () => {
      const sb = makeSandbox({ network: { enabled: false } });
      expect(sb.validateCommand("ls -la")).toEqual({ allowed: true });
      expect(sb.validateCommand("git status")).toEqual({ allowed: true });
      expect(sb.validateCommand("npm test")).toEqual({ allowed: true });
    });
  });

  describe("buildExecOptions", () => {
    it("returns correct base options", () => {
      const sb = makeSandbox({});
      const opts = sb.buildExecOptions("echo hello", 5000);
      expect(opts.timeout).toBe(5000);
      expect(opts.cwd).toBe(CWD);
      expect(opts.maxBuffer).toBe(10 * 1024 * 1024);
      expect(typeof opts.shell).toBe("string");
    });

    it("includes ulimit on non-Windows", () => {
      if (process.platform === "win32") return; // Skip on Windows
      const sb = makeSandbox({ resources: { maxMemoryMB: 512, maxCpuSeconds: 30 } });
      const opts = sb.buildExecOptions("echo hello", 5000);
      expect(opts.command).toContain("ulimit -v 524288");
      expect(opts.command).toContain("ulimit -t 30");
      expect(opts.command).toContain("echo hello");
    });

    it("does not add ulimit on Windows", () => {
      if (process.platform !== "win32") return; // Skip on non-Windows
      const sb = makeSandbox({ resources: { maxMemoryMB: 512 } });
      const opts = sb.buildExecOptions("echo hello", 5000);
      expect(opts.command).toBe("echo hello");
    });

    it("filters environment in exec options", () => {
      const origEnv = process.env;
      process.env = { ...origEnv, PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-secret" };
      try {
        const sb = makeSandbox({});
        const opts = sb.buildExecOptions("echo hello", 5000);
        expect(opts.env).not.toHaveProperty("ANTHROPIC_API_KEY");
        expect(opts.env).toHaveProperty("PATH");
      } finally {
        process.env = origEnv;
      }
    });
  });
});
