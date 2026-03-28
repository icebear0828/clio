import type { SystemPromptSection, SystemPromptBlock } from "../types.js";

export class SectionCache {
  private cache = new Map<string, string | null>();

  async processSections(sections: SystemPromptSection[]): Promise<SystemPromptBlock[]> {
    const results = await Promise.all(
      sections.map(async (section) => {
        let text: string | null;

        if (!section.cacheBreak && this.cache.has(section.name)) {
          text = this.cache.get(section.name) ?? null;
        } else {
          text = await section.compute();
          this.cache.set(section.name, text);
        }

        if (!text) return null;

        const block: SystemPromptBlock = { type: "text", text };
        if (section.scope) {
          block.cache_control = { type: "ephemeral", scope: section.scope };
        }
        return block;
      }),
    );

    return results.filter((b): b is SystemPromptBlock => b !== null);
  }

  clear(): void {
    this.cache.clear();
  }
}
