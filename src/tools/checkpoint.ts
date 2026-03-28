import { promises as fs } from "fs";
import path from "path";

interface FileSnapshot {
  filePath: string;
  content: string | null; // null = file did not exist (was created)
}

interface Checkpoint {
  snapshots: FileSnapshot[];
  snapshotPaths: Set<string>;
  messageCountBefore: number;
  timestamp: number;
}

export class CheckpointManager {
  private current: Checkpoint | null = null;

  begin(messageCount: number): void {
    this.current = {
      snapshots: [],
      snapshotPaths: new Set(),
      messageCountBefore: messageCount,
      timestamp: Date.now(),
    };
  }

  async snapshotFile(filePath: string): Promise<void> {
    if (!this.current) return;
    const abs = path.resolve(filePath);
    if (this.current.snapshotPaths.has(abs)) return; // already captured
    this.current.snapshotPaths.add(abs);

    let content: string | null;
    try {
      content = await fs.readFile(abs, "utf-8");
    } catch {
      content = null; // file doesn't exist yet (will be created)
    }
    this.current.snapshots.push({ filePath: abs, content });
  }

  getCurrent(): Checkpoint | null {
    return this.current;
  }

  getMessageCountBefore(): number {
    return this.current?.messageCountBefore ?? 0;
  }

  getModifiedFiles(): Array<{ filePath: string; isNew: boolean }> {
    if (!this.current) return [];
    return this.current.snapshots.map((s) => ({
      filePath: s.filePath,
      isNew: s.content === null,
    }));
  }

  async rollback(): Promise<string[]> {
    if (!this.current) return [];
    const restored: string[] = [];
    for (const snap of this.current.snapshots) {
      try {
        if (snap.content === null) {
          await fs.unlink(snap.filePath);
        } else {
          await fs.writeFile(snap.filePath, snap.content, "utf-8");
        }
        restored.push(snap.filePath);
      } catch {
        // Best effort - file may have been moved/deleted by user
      }
    }
    this.current = null;
    return restored;
  }

  commit(): void {
    this.current = null;
  }
}
