import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export interface FileSnapshot {
  filePath: string;
  hash: string | null; // null = file did not exist (was created)
}

export interface Checkpoint {
  id: string;
  snapshots: FileSnapshot[];
  snapshotPaths: Set<string>;
  messageCountBefore: number;
  timestamp: number;
}

export interface ManifestEntry {
  id: string;
  timestamp: number;
  messageCountBefore: number;
  snapshots: { filePath: string; hash: string | null }[];
}

export class CheckpointManager {
  private current: Checkpoint | null = null;
  private readonly historyDir: string;
  private readonly filesDir: string;
  private readonly manifestPath: string;

  constructor(workspaceDir: string = process.cwd()) {
    this.historyDir = path.join(workspaceDir, ".clio", "history");
    this.filesDir = path.join(this.historyDir, "files");
    this.manifestPath = path.join(this.historyDir, "manifest.json");
  }

  private async initializeStorage(): Promise<void> {
    await fs.mkdir(this.filesDir, { recursive: true });
  }

  private async readManifest(): Promise<ManifestEntry[]> {
    try {
      const data = await fs.readFile(this.manifestPath, "utf-8");
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  private async writeManifest(entries: ManifestEntry[]): Promise<void> {
    await this.initializeStorage();
    await fs.writeFile(this.manifestPath, JSON.stringify(entries, null, 2), "utf-8");
  }

  begin(messageCount: number): void {
    const id = crypto.randomBytes(4).toString("hex");
    this.current = {
      id,
      snapshots: [],
      snapshotPaths: new Set(),
      messageCountBefore: messageCount,
      timestamp: Date.now(),
    };
  }

  async snapshotFile(filePath: string): Promise<void> {
    if (!this.current) return;
    const abs = path.resolve(filePath);
    if (this.current.snapshotPaths.has(abs)) return;
    this.current.snapshotPaths.add(abs);

    await this.initializeStorage();

    try {
      const stat = await fs.stat(abs);
      if (stat.isFile()) {
        const content = await fs.readFile(abs);
        const hash = crypto.createHash("sha256").update(content).digest("hex");
        const backupPath = path.join(this.filesDir, hash);
        
        try {
          await fs.access(backupPath);
        } catch {
          await fs.writeFile(backupPath, content);
        }

        this.current.snapshots.push({ filePath: abs, hash });
      } else {
        this.current.snapshots.push({ filePath: abs, hash: null });
      }
    } catch {
      this.current.snapshots.push({ filePath: abs, hash: null });
    }
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
      isNew: s.hash === null,
    }));
  }

  async rollback(): Promise<string[]> {
    if (!this.current) return [];
    const restored = await this.restoreSnapshots(this.current.snapshots);
    this.current = null;
    return restored;
  }

  async commit(): Promise<void> {
    if (!this.current || this.current.snapshots.length === 0) {
      this.current = null;
      return;
    }
    const entries = await this.readManifest();
    const entry: ManifestEntry = {
      id: this.current.id,
      timestamp: this.current.timestamp,
      messageCountBefore: this.current.messageCountBefore,
      snapshots: this.current.snapshots.map((s) => ({ filePath: s.filePath, hash: s.hash })),
    };
    entries.push(entry);

    if (entries.length > 50) {
      entries.splice(0, entries.length - 50);
      await this.cleanupOrphans(entries);
    }

    await this.writeManifest(entries);
    this.current = null;
  }

  async getHistory(): Promise<ManifestEntry[]> {
    return this.readManifest();
  }

  async restoreCheckpoint(id: string): Promise<string[]> {
    const entries = await this.readManifest();
    const entry = entries.find((e) => e.id === id);
    if (!entry) throw new Error("Checkpoint not found");

    return this.restoreSnapshots(entry.snapshots);
  }

  private async restoreSnapshots(snapshots: { filePath: string; hash: string | null }[]): Promise<string[]> {
    const restored: string[] = [];
    for (const snap of snapshots) {
      try {
        if (snap.hash === null) {
          await fs.unlink(snap.filePath).catch(() => {});
        } else {
          const backupPath = path.join(this.filesDir, snap.hash);
          await fs.mkdir(path.dirname(snap.filePath), { recursive: true }).catch(() => {});
          await fs.copyFile(backupPath, snap.filePath);
        }
        restored.push(snap.filePath);
      } catch {
        // Best effort
      }
    }
    return restored;
  }

  private async cleanupOrphans(activeEntries: ManifestEntry[]): Promise<void> {
    const activeHashes = new Set<string>();
    for (const entry of activeEntries) {
      for (const snap of entry.snapshots) {
        if (snap.hash) activeHashes.add(snap.hash);
      }
    }

    try {
      const files = await fs.readdir(this.filesDir);
      for (const file of files) {
        if (!activeHashes.has(file)) {
          await fs.unlink(path.join(this.filesDir, file)).catch(() => {});
        }
      }
    } catch {}
  }
}
