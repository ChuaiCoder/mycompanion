import { z } from "zod";

// Preserve every extension-owned field. A document is addressed by its display
// name in SQLite, never by a user-controlled filesystem path.
export const worldInfoDocumentSchema = z.object({
  entries: z.record(z.string(), z.record(z.string(), z.unknown())),
}).passthrough();
export type WorldInfoDocument = z.infer<typeof worldInfoDocumentSchema>;

export const worldInfoSettingsSchema = z.object({
  world_info: z.object({
    globalSelect: z.array(z.string()).default([]),
    charLore: z.array(z.object({ name: z.string(), extraBooks: z.array(z.string()) }).passthrough()).default([]),
  }).passthrough().default({ globalSelect: [], charLore: [] }),
  world_info_depth: z.number().int().min(0).max(1000).default(2),
  world_info_min_activations: z.number().int().nonnegative().default(0),
  world_info_min_activations_depth_max: z.number().int().nonnegative().default(0),
  world_info_budget: z.number().nonnegative().default(25),
  world_info_budget_cap: z.number().int().nonnegative().default(0),
  world_info_include_names: z.boolean().default(true),
  world_info_recursive: z.boolean().default(false),
  world_info_overflow_alert: z.boolean().default(false),
  world_info_case_sensitive: z.boolean().default(false),
  world_info_match_whole_words: z.boolean().default(false),
  world_info_use_group_scoring: z.boolean().default(false),
  world_info_character_strategy: z.number().int().min(0).max(2).default(1),
  world_info_max_recursion_steps: z.number().int().nonnegative().default(0),
}).passthrough();
export type WorldInfoSettings = z.infer<typeof worldInfoSettingsSchema>;
