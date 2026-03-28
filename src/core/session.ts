import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import type { Message, UsageStats } from "../types.js";

const SESSIONS_DIR = path.join(os.homedir(), ".clio", "sessions");

interface SessionData {
  id: string;
  cwd: string;
  model: string;
  messages: Message[];
  usage: UsageStats;
  createdAt: string;
  updatedAt: string;
}

function generateId(): string {
  return crypto.randomBytes(4).toString("hex");
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
}

function sessionPath(id: string): string {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

export class SessionManager {
  private id: string;
  private cwd: string;
  private model: string;
  private createdAt: string;

  constructor(model: string) {
    this.id = generateId();
    this.cwd = process.cwd();
    this.model = model;
    this.createdAt = new Date().toISOString();
  }

  getId(): string {
    return this.id;
  }

  /** Save current state to disk. */
  async save(messages: Message[], usage: UsageStats): Promise<void> {
    if (messages.length === 0) return;

    await ensureDir();
    const data: SessionData = {
      id: this.id,
      cwd: this.cwd,
      model: this.model,
      messages,
      usage,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(sessionPath(this.id), JSON.stringify(data), "utf-8");
  }

  /** Restore a session by id. Returns messages and usage, or null if not found. */
  static async restore(
    id: string
  ): Promise<{ messages: Message[]; usage: UsageStats; model: string } | null> {
    try {
      const raw = await fs.readFile(sessionPath(id), "utf-8");
      const data = JSON.parse(raw) as SessionData;
      return {
        messages: data.messages,
        usage: data.usage,
        model: data.model,
      };
    } catch {
      return null;
    }
  }

  static async fork(sourceId: string, model: string): Promise<{
    manager: SessionManager;
    messages: Message[];
    usage: UsageStats;
  } | null> {
    const data = await SessionManager.restore(sourceId);
    if (!data) return null;
    const manager = new SessionManager(model);
    return { manager, messages: data.messages, usage: data.usage };
  }

  /** Search sessions for a query string. Returns matching sessions with matched snippets. */
  static async search(
    query: string,
    limit = 10,
  ): Promise<Array<{ id: string; cwd: string; model: string; updatedAt: string; messageCount: number; matches: string[] }>> {
    await ensureDir();
    const files = await fs.readdir(SESSIONS_DIR);
    const lowerQuery = query.toLowerCase();
    const results: Array<{ data: SessionData; matches: string[] }> = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(SESSIONS_DIR, file), "utf-8");
        const data = JSON.parse(raw) as SessionData;
        const matches: string[] = [];

        for (const msg of data.messages) {
          if (!msg.content) continue;
          const blocks = typeof msg.content === "string"
            ? [msg.content]
            : (msg.content as Array<{ type: string; text?: string }>)
                .filter((b) => b.type === "text" && b.text)
                .map((b) => b.text!);

          for (const text of blocks) {
            const idx = text.toLowerCase().indexOf(lowerQuery);
            if (idx !== -1) {
              const start = Math.max(0, idx - 40);
              const end = Math.min(text.length, idx + query.length + 40);
              const snippet = (start > 0 ? "..." : "") + text.slice(start, end).replace(/\n/g, " ") + (end < text.length ? "..." : "");
              matches.push(snippet);
              if (matches.length >= 3) break;
            }
          }
          if (matches.length >= 3) break;
        }

        if (matches.length > 0) {
          results.push({ data, matches });
        }
      } catch {
        // skip corrupt files
      }
    }

    return results
      .sort((a, b) => b.data.updatedAt.localeCompare(a.data.updatedAt))
      .slice(0, limit)
      .map((r) => ({
        id: r.data.id,
        cwd: r.data.cwd,
        model: r.data.model,
        updatedAt: r.data.updatedAt,
        messageCount: r.data.messages.length,
        matches: r.matches,
      }));
  }

  /** List recent sessions (newest first). */
  static async list(limit = 10): Promise<Array<{ id: string; cwd: string; model: string; updatedAt: string; messageCount: number }>> {
    await ensureDir();
    const files = await fs.readdir(SESSIONS_DIR);
    const sessions: Array<SessionData> = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(SESSIONS_DIR, file), "utf-8");
        sessions.push(JSON.parse(raw) as SessionData);
      } catch {
        // skip corrupt files
      }
    }

    return sessions
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((s) => ({
        id: s.id,
        cwd: s.cwd,
        model: s.model,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
      }));
  }
}
