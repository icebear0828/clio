import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ContentBlock } from "./types.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const MIME_MAP: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Parse user input for image file paths.
 * Returns content blocks: text + any detected images.
 *
 * Image detection: any token that looks like a file path ending in
 * .png/.jpg/.jpeg/.gif/.webp is checked on disk.
 */
export async function parseInputWithImages(
  input: string
): Promise<string | ContentBlock[]> {
  // Quick check: does input contain any image extension?
  const hasImageExt = [...IMAGE_EXTENSIONS].some((ext) =>
    input.toLowerCase().includes(ext)
  );
  if (!hasImageExt) return input;

  // Find potential image paths (tokens containing image extensions)
  const tokens = input.split(/\s+/);
  const imagePaths: string[] = [];
  const textParts: string[] = [];

  for (const token of tokens) {
    const ext = path.extname(token).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      const resolved = path.resolve(token);
      try {
        await fs.access(resolved);
        imagePaths.push(resolved);
        continue;
      } catch {
        // Not a valid file path, treat as text
      }
    }
    textParts.push(token);
  }

  if (imagePaths.length === 0) return input;

  // Build content blocks: images first, then text
  const blocks: ContentBlock[] = [];

  for (const imgPath of imagePaths) {
    const ext = path.extname(imgPath).toLowerCase();
    const mediaType = MIME_MAP[ext];
    if (!mediaType) continue;

    const data = await fs.readFile(imgPath);
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: data.toString("base64"),
      },
    });
  }

  const text = textParts.join(" ").trim();
  if (text) {
    blocks.push({ type: "text", text });
  } else {
    blocks.push({ type: "text", text: "What is in this image?" });
  }

  return blocks;
}
