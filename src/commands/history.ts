import type { CheckpointManager } from "../tools/checkpoint.js";
import { bold, boldCyan, dim, red, green, yellow } from "../ui/render.js";
import type { Message } from "../types.js";

export async function historyCommand(cm: CheckpointManager): Promise<void> {
  const history = await cm.getHistory();
  if (history.length === 0) {
    console.log(dim("  No history available.\n"));
    return;
  }

  console.log(`\n  ${bold("Time Travel History:")}\n`);
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    const date = new Date(entry.timestamp).toLocaleString();
    const files = entry.snapshots.length;
    console.log(`    ${boldCyan(entry.id)}  ${dim(date)}  ${yellow(`${files} file(s) modified`)}`);
  }
  console.log(dim(`\n  Restore a snapshot: /undo <id>\n`));
}

export async function undoCommand(cm: CheckpointManager, id: string, messages: Message[]): Promise<void> {
  if (!id) {
    console.log(red("  Error: Please provide a checkpoint id (e.g. /undo 1e2f3a4b)\n"));
    return;
  }
  try {
    const history = await cm.getHistory();
    const entry = history.find(e => e.id === id);
    if (!entry) {
      console.log(red(`  Error: Checkpoint ${id} not found.\n`));
      return;
    }
    const restored = await cm.restoreCheckpoint(id);
    messages.length = entry.messageCountBefore;
    console.log(green(`\n  Successfully restored ${restored.length} file(s) and rewound conversation.`));
    for (const f of restored) {
      console.log(`    ${dim("›")} ${f}`);
    }
    console.log();
  } catch (err) {
    console.error(red(`  Undo failed: ${err instanceof Error ? err.message : err}\n`));
  }
}
