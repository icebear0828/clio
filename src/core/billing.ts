import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import type { SystemPromptBlock } from "../types.js";

const VERSION = "2.1.86";

let cachedHeader: SystemPromptBlock | null = null;

export function createBillingHeader(): SystemPromptBlock {
  if (cachedHeader) return cachedHeader;

  let gitHash = "unknown";
  try {
    gitHash = execSync("git rev-parse --short HEAD", { timeout: 3000 })
      .toString()
      .trim();
  } catch {
    // not in a git repo or git unavailable
  }

  const versionFull = `${VERSION}.${gitHash}`;
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "cli";
  const cch = crypto
    .createHash("md5")
    .update(versionFull)
    .digest("hex")
    .slice(0, 5);

  cachedHeader = {
    type: "text",
    text: `x-anthropic-billing-header: cc_version=${versionFull}; cc_entrypoint=${entrypoint}; cch=${cch};`,
  };
  return cachedHeader;
}
