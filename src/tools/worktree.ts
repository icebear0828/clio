import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as crypto from "node:crypto";

const execAsync = promisify(exec);

export interface WorktreeInfo {
  worktreePath: string;
  branchName: string;
}

export async function createWorktree(): Promise<WorktreeInfo> {
  const hex = crypto.randomBytes(4).toString("hex");
  const branchName = `clio-agent-${hex}`;
  const worktreePath = path.resolve(".clio", "worktrees", branchName);

  await execAsync(`git worktree add "${worktreePath}" -b "${branchName}"`);
  return { worktreePath, branchName };
}

export async function hasChanges(worktreePath: string): Promise<boolean> {
  const { stdout } = await execAsync(`git -C "${worktreePath}" status --porcelain`);
  return stdout.trim().length > 0;
}

export async function cleanupWorktree(info: WorktreeInfo): Promise<void> {
  try {
    await execAsync(`git worktree remove "${info.worktreePath}" --force`);
  } catch {
    // worktree may already be removed
  }
  try {
    await execAsync(`git branch -D "${info.branchName}"`);
  } catch {
    // branch may not exist
  }
}
