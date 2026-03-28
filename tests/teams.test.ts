import { describe, it, expect, beforeEach } from "vitest";
import { teamRegistry, createMessageHook, type TeamMemberInput } from "../src/tools/teams.js";

// Reset team registry state between tests
// Since TeamRegistry uses a counter, we test with unique names

describe("TeamRegistry", () => {
  describe("create", () => {
    it("creates a team with members", () => {
      const members: TeamMemberInput[] = [
        { name: "alice", role: "frontend", prompt: "Build the UI" },
        { name: "bob", role: "backend", prompt: "Build the API" },
      ];

      const team = teamRegistry.create("dev-team", "Build the app", members);
      expect(team.id).toMatch(/^team_\d+$/);
      expect(team.name).toBe("dev-team");
      expect(team.task).toBe("Build the app");
      expect(team.members.size).toBe(2);
      expect(team.members.get("alice")?.role).toBe("frontend");
      expect(team.members.get("alice")?.status).toBe("idle");
      expect(team.members.get("bob")?.role).toBe("backend");
    });

    it("assigns unique IDs", () => {
      const t1 = teamRegistry.create("t1", "task1", [{ name: "a", prompt: "do" }]);
      const t2 = teamRegistry.create("t2", "task2", [{ name: "b", prompt: "do" }]);
      expect(t1.id).not.toBe(t2.id);
      teamRegistry.delete(t1.id);
      teamRegistry.delete(t2.id);
    });
  });

  describe("get / list / delete", () => {
    it("gets a team by ID", () => {
      const team = teamRegistry.create("get-test", "task", [{ name: "m", prompt: "do" }]);
      const fetched = teamRegistry.get(team.id);
      expect(fetched.name).toBe("get-test");
      teamRegistry.delete(team.id);
    });

    it("throws on unknown team ID", () => {
      expect(() => teamRegistry.get("team_99999")).toThrow(/not found/);
    });

    it("lists all teams", () => {
      const t1 = teamRegistry.create("list-1", "task", [{ name: "a", prompt: "do" }]);
      const t2 = teamRegistry.create("list-2", "task", [{ name: "b", prompt: "do" }]);
      const list = teamRegistry.list();
      const ids = list.map((t) => t.id);
      expect(ids).toContain(t1.id);
      expect(ids).toContain(t2.id);
      teamRegistry.delete(t1.id);
      teamRegistry.delete(t2.id);
    });

    it("deletes a team", () => {
      const team = teamRegistry.create("del-test", "task", [{ name: "m", prompt: "do" }]);
      teamRegistry.delete(team.id);
      expect(() => teamRegistry.get(team.id)).toThrow(/not found/);
    });
  });

  describe("messaging", () => {
    it("sends and retrieves messages", () => {
      const team = teamRegistry.create("msg-test", "task", [
        { name: "alice", prompt: "do" },
        { name: "bob", prompt: "do" },
      ]);

      teamRegistry.sendMessage(team.id, "alice", "bob", "Hello Bob!");
      const msgs = teamRegistry.getMessagesFor(team.id, "bob");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].from).toBe("alice");
      expect(msgs[0].content).toBe("Hello Bob!");

      teamRegistry.delete(team.id);
    });

    it("broadcast reaches all members", () => {
      const team = teamRegistry.create("broadcast-test", "task", [
        { name: "alice", prompt: "do" },
        { name: "bob", prompt: "do" },
        { name: "carol", prompt: "do" },
      ]);

      teamRegistry.sendMessage(team.id, "alice", "all", "Heads up everyone!");

      const bobMsgs = teamRegistry.getMessagesFor(team.id, "bob");
      const carolMsgs = teamRegistry.getMessagesFor(team.id, "carol");
      expect(bobMsgs).toHaveLength(1);
      expect(carolMsgs).toHaveLength(1);

      // Sender doesn't receive own broadcast
      const aliceMsgs = teamRegistry.getMessagesFor(team.id, "alice");
      expect(aliceMsgs).toHaveLength(0);

      teamRegistry.delete(team.id);
    });

    it("filters messages by timestamp", async () => {
      const team = teamRegistry.create("ts-test", "task", [
        { name: "alice", prompt: "do" },
        { name: "bob", prompt: "do" },
      ]);

      teamRegistry.sendMessage(team.id, "alice", "bob", "First");
      const afterFirst = Date.now();

      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 10));

      teamRegistry.sendMessage(team.id, "alice", "bob", "Second");

      const allMsgs = teamRegistry.getMessagesFor(team.id, "bob");
      expect(allMsgs).toHaveLength(2);

      const newMsgs = teamRegistry.getMessagesFor(team.id, "bob", afterFirst);
      expect(newMsgs).toHaveLength(1);
      expect(newMsgs[0].content).toBe("Second");

      teamRegistry.delete(team.id);
    });
  });

  describe("member status", () => {
    it("updates member status", () => {
      const team = teamRegistry.create("status-test", "task", [
        { name: "alice", prompt: "do" },
      ]);

      expect(team.members.get("alice")?.status).toBe("idle");

      teamRegistry.updateMemberStatus(team.id, "alice", "running");
      expect(team.members.get("alice")?.status).toBe("running");

      teamRegistry.updateMemberStatus(team.id, "alice", "completed", "Done!");
      expect(team.members.get("alice")?.status).toBe("completed");
      expect(team.members.get("alice")?.result).toBe("Done!");

      teamRegistry.delete(team.id);
    });

    it("throws on unknown member", () => {
      const team = teamRegistry.create("unknown-member", "task", [
        { name: "alice", prompt: "do" },
      ]);

      expect(() =>
        teamRegistry.updateMemberStatus(team.id, "unknown", "running")
      ).toThrow(/not found/);

      teamRegistry.delete(team.id);
    });
  });

  describe("formatTeamStatus", () => {
    it("formats team status correctly", () => {
      const team = teamRegistry.create("fmt-test", "Build app", [
        { name: "alice", role: "frontend", prompt: "Build UI" },
        { name: "bob", prompt: "Build API" },
      ]);

      teamRegistry.updateMemberStatus(team.id, "alice", "running");

      const status = teamRegistry.formatTeamStatus(team);
      expect(status).toContain("fmt-test");
      expect(status).toContain("Build app");
      expect(status).toContain("alice [frontend]: running");
      expect(status).toContain("bob: idle");

      teamRegistry.delete(team.id);
    });
  });
});

describe("createMessageHook", () => {
  it("returns null when no new messages", async () => {
    const team = teamRegistry.create("hook-test", "task", [
      { name: "alice", prompt: "do" },
      { name: "bob", prompt: "do" },
    ]);

    const hook = createMessageHook(team.id, "bob");
    const result = await hook();
    expect(result).toBeNull();

    teamRegistry.delete(team.id);
  });

  it("returns formatted messages and advances timestamp", async () => {
    const team = teamRegistry.create("hook-msg", "task", [
      { name: "alice", prompt: "do" },
      { name: "bob", prompt: "do" },
    ]);

    const hook = createMessageHook(team.id, "bob");

    // Small delay so message timestamp > hook creation time
    await new Promise((r) => setTimeout(r, 10));

    teamRegistry.sendMessage(team.id, "alice", "bob", "Do task X");

    const result = await hook();
    expect(result).toContain("<team-messages>");
    expect(result).toContain("[From alice]: Do task X");

    // Second call should return null (no new messages)
    const result2 = await hook();
    expect(result2).toBeNull();

    teamRegistry.delete(team.id);
  });

  it("returns null gracefully on deleted team", async () => {
    const team = teamRegistry.create("hook-deleted", "task", [
      { name: "alice", prompt: "do" },
    ]);

    const hook = createMessageHook(team.id, "alice");
    teamRegistry.delete(team.id);

    const result = await hook();
    expect(result).toBeNull();
  });
});
