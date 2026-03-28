// ── Types ──

export type MemberStatus = "idle" | "running" | "completed" | "failed";

export interface TeamMemberInput {
  name: string;
  role?: string;
  prompt: string;
  agent_type?: string;
  model?: string;
}

export interface TeamMember {
  name: string;
  role?: string;
  agentType?: string;
  model?: string;
  status: MemberStatus;
  result?: string;
  abort?: AbortController;
}

export interface TeamMessage {
  from: string;
  to: string;
  content: string;
  timestamp: number;
}

export interface Team {
  id: string;
  name: string;
  task: string;
  members: Map<string, TeamMember>;
  messages: TeamMessage[];
  createdAt: number;
}

// ── TeamRegistry ──

class TeamRegistry {
  private teams = new Map<string, Team>();
  private counter = 0;

  create(name: string, task: string, memberInputs: TeamMemberInput[]): Team {
    const id = `team_${++this.counter}`;
    const members = new Map<string, TeamMember>();

    for (const input of memberInputs) {
      members.set(input.name, {
        name: input.name,
        role: input.role,
        agentType: input.agent_type,
        model: input.model,
        status: "idle",
      });
    }

    const team: Team = {
      id,
      name,
      task,
      members,
      messages: [],
      createdAt: Date.now(),
    };

    this.teams.set(id, team);
    return team;
  }

  delete(id: string): void {
    const team = this.teams.get(id);
    if (!team) throw new Error(`Team not found: ${id}`);

    // Abort running members
    for (const member of team.members.values()) {
      if (member.abort && member.status === "running") {
        member.abort.abort();
      }
    }

    this.teams.delete(id);
  }

  get(id: string): Team {
    const team = this.teams.get(id);
    if (!team) throw new Error(`Team not found: ${id}`);
    return team;
  }

  list(): Team[] {
    return [...this.teams.values()];
  }

  sendMessage(teamId: string, from: string, to: string, content: string): void {
    const team = this.get(teamId);
    team.messages.push({
      from,
      to,
      content,
      timestamp: Date.now(),
    });
  }

  getMessagesFor(teamId: string, memberName: string, since?: number): TeamMessage[] {
    const team = this.get(teamId);
    return team.messages.filter((msg) => {
      const isRecipient = msg.to === memberName || msg.to === "all";
      const isAfterTimestamp = since == null || msg.timestamp > since;
      const isNotSelf = msg.from !== memberName;
      return isRecipient && isAfterTimestamp && isNotSelf;
    });
  }

  updateMemberStatus(teamId: string, memberName: string, status: MemberStatus, result?: string): void {
    const team = this.get(teamId);
    const member = team.members.get(memberName);
    if (!member) throw new Error(`Member '${memberName}' not found in team '${teamId}'`);
    member.status = status;
    if (result !== undefined) member.result = result;
  }

  setMemberAbort(teamId: string, memberName: string, abort: AbortController): void {
    const team = this.get(teamId);
    const member = team.members.get(memberName);
    if (member) member.abort = abort;
  }

  formatTeamStatus(team: Team): string {
    const lines: string[] = [
      `Team: ${team.name} (${team.id})`,
      `Task: ${team.task}`,
      `Members:`,
    ];

    for (const member of team.members.values()) {
      const role = member.role ? ` [${member.role}]` : "";
      lines.push(`  - ${member.name}${role}: ${member.status}`);
    }

    if (team.messages.length > 0) {
      lines.push(`Messages: ${team.messages.length}`);
    }

    return lines.join("\n");
  }
}

// ── Singleton ──

export const teamRegistry = new TeamRegistry();

// ── Message hook factory ──

export function createMessageHook(
  teamId: string,
  memberName: string,
): () => Promise<string | null> {
  let lastCheck = Date.now();

  return async (): Promise<string | null> => {
    try {
      const messages = teamRegistry.getMessagesFor(teamId, memberName, lastCheck);
      lastCheck = Date.now();

      if (messages.length === 0) return null;

      const formatted = messages
        .map((m) => `[From ${m.from}]: ${m.content}`)
        .join("\n");

      return `<team-messages>\n${formatted}\n</team-messages>`;
    } catch {
      return null;
    }
  };
}
