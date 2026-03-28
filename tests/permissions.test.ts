import { describe, it, expect, vi } from "vitest";
import { PermissionManager } from "../src/core/permissions.js";

describe("PermissionManager", () => {
  describe("mode accessors", () => {
    it("gets and sets mode", () => {
      const pm = new PermissionManager("default");
      expect(pm.getMode()).toBe("default");
      pm.setMode("plan");
      expect(pm.getMode()).toBe("plan");
    });
  });

  describe("plan mode", () => {
    it("allows safe tools", async () => {
      const pm = new PermissionManager("plan");
      expect(await pm.check("Read", {})).toBe("allow");
      expect(await pm.check("Glob", {})).toBe("allow");
      expect(await pm.check("Grep", {})).toBe("allow");
    });

    it("denies dangerous tools", async () => {
      const pm = new PermissionManager("plan");
      expect(await pm.check("Bash", { command: "ls" })).toBe("deny");
      expect(await pm.check("Write", { file_path: "x" })).toBe("deny");
    });

    it("always allows EnterPlanMode/ExitPlanMode", async () => {
      const pm = new PermissionManager("plan");
      expect(await pm.check("EnterPlanMode", {})).toBe("allow");
      expect(await pm.check("ExitPlanMode", {})).toBe("allow");
    });
  });

  describe("auto mode without classifier", () => {
    it("allows everything", async () => {
      const pm = new PermissionManager("auto");
      expect(await pm.check("Bash", { command: "rm -rf /" })).toBe("allow");
      expect(await pm.check("Write", { file_path: "x" })).toBe("allow");
    });
  });

  describe("auto mode with classifier", () => {
    it("allows safe-classified bash commands", async () => {
      const pm = new PermissionManager("auto");
      pm.setAutoClassifier({ enabled: true });
      expect(await pm.check("Bash", { command: "git status" })).toBe("allow");
      expect(await pm.check("Bash", { command: "ls -la" })).toBe("allow");
    });

    it("allows Agent tool in auto mode with classifier", async () => {
      const pm = new PermissionManager("auto");
      pm.setAutoClassifier({ enabled: true });
      expect(await pm.check("Agent", {})).toBe("allow");
    });

    it("allows safe tools regardless of classifier", async () => {
      const pm = new PermissionManager("auto");
      pm.setAutoClassifier({ enabled: true });
      expect(await pm.check("Read", {})).toBe("allow");
      expect(await pm.check("TaskCreate", {})).toBe("allow");
    });

    it("prompts for dangerous-classified bash commands", async () => {
      const pm = new PermissionManager("auto");
      pm.setAutoClassifier({ enabled: true });
      // Mock promptUser to return "deny" so we can verify it was reached
      const spy = vi.spyOn(pm as never, "promptUser").mockResolvedValue("deny");
      expect(await pm.check("Bash", { command: "rm -rf /home" })).toBe("deny");
      expect(spy).toHaveBeenCalledWith("Bash");
      spy.mockRestore();
    });

    it("prompts for unrecognized bash commands", async () => {
      const pm = new PermissionManager("auto");
      pm.setAutoClassifier({ enabled: true });
      const spy = vi.spyOn(pm as never, "promptUser").mockResolvedValue("allow");
      expect(await pm.check("Bash", { command: "some-unknown-command --flag" })).toBe("allow");
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("prompts for write tools in auto mode with classifier", async () => {
      const pm = new PermissionManager("auto");
      pm.setAutoClassifier({ enabled: true });
      const spy = vi.spyOn(pm as never, "promptUser").mockResolvedValue("deny");
      expect(await pm.check("Write", { file_path: "x" })).toBe("deny");
      expect(spy).toHaveBeenCalledWith("Write");
      spy.mockRestore();
    });
  });

  describe("deny rules", () => {
    it("deny rules block before anything else", async () => {
      const pm = new PermissionManager("auto", [], ["rm -rf *"]);
      expect(await pm.check("Bash", { command: "rm -rf /home" })).toBe("deny");
    });

    it("deny rules work in auto mode", async () => {
      const pm = new PermissionManager("auto", [], ["sudo *"]);
      expect(await pm.check("Bash", { command: "sudo apt install" })).toBe("deny");
    });
  });

  describe("allow rules (default mode)", () => {
    it("allow rules auto-approve matching Bash commands", async () => {
      const pm = new PermissionManager("default", ["git *", "npm *"]);
      expect(await pm.check("Bash", { command: "git status" })).toBe("allow");
      expect(await pm.check("Bash", { command: "npm install" })).toBe("allow");
    });

    it("allow rules match MCP tools by name", async () => {
      const pm = new PermissionManager("default", ["mcp__*"]);
      expect(await pm.check("mcp__server__tool", {})).toBe("allow");
    });
  });

  describe("tool categorization", () => {
    it("treats unknown tools as dangerous", async () => {
      const pm = new PermissionManager("plan");
      expect(await pm.check("SomeUnknownTool", {})).toBe("deny");
    });
  });
});
