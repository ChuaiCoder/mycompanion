import { z } from "zod";

const extensionRecordSchema = z.record(z.string(), z.unknown());

const lorebookEntryV2Schema = z
  .object({
    keys: z.array(z.string()),
    content: z.string(),
    extensions: extensionRecordSchema,
    enabled: z.boolean(),
    insertion_order: z.number(),
    case_sensitive: z.boolean().optional(),
    name: z.string().optional(),
    priority: z.number().optional(),
    id: z.union([z.number(), z.string()]).optional(),
    comment: z.string().optional(),
    selective: z.boolean().optional(),
    secondary_keys: z.array(z.string()).optional(),
    constant: z.boolean().optional(),
    position: z.enum(["before_char", "after_char"]).optional(),
  })
  .passthrough();

const lorebookEntryV3Schema = lorebookEntryV2Schema.extend({
  use_regex: z.boolean().optional(),
});

function createLorebookSchema(entrySchema: typeof lorebookEntryV2Schema) {
  return z
    .object({
      name: z.string().optional(),
      description: z.string().optional(),
      scan_depth: z.number().optional(),
      token_budget: z.number().optional(),
      recursive_scanning: z.boolean().optional(),
      extensions: extensionRecordSchema.optional(),
      entries: z.array(entrySchema),
    })
    .passthrough();
}

const characterBookV2Schema = createLorebookSchema(lorebookEntryV2Schema);
const characterBookV3Schema = createLorebookSchema(lorebookEntryV3Schema);

const commonDataShape = {
  name: z.string(),
  description: z.string(),
  personality: z.string(),
  scenario: z.string(),
  first_mes: z.string(),
  mes_example: z.string(),
  creator_notes: z.string(),
  system_prompt: z.string(),
  post_history_instructions: z.string(),
  alternate_greetings: z.array(z.string()),
  tags: z.array(z.string()),
  creator: z.string(),
  character_version: z.string(),
  extensions: extensionRecordSchema,
} satisfies z.ZodRawShape;

export const characterCardV2Schema = z
  .object({
    spec: z.literal("chara_card_v2"),
    spec_version: z.literal("2.0"),
    data: z
      .object({
        ...commonDataShape,
        character_book: characterBookV2Schema.optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const characterCardV3Schema = z
  .object({
    spec: z.literal("chara_card_v3"),
    spec_version: z.literal("3.0"),
    data: z
      .object({
        ...commonDataShape,
        character_book: characterBookV3Schema.optional(),
        assets: z
          .array(
            z
              .object({
                type: z.string(),
                uri: z.string(),
                name: z.string(),
                ext: z.string(),
              })
              .passthrough(),
          )
          .optional(),
        creator_notes_multilingual: z
          .record(z.string(), z.string())
          .optional(),
        source: z.array(z.string()).optional(),
        group_only_greetings: z.array(z.string()).optional(),
        creation_date: z.number().optional(),
        modification_date: z.number().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type CharacterCardV2 = z.infer<typeof characterCardV2Schema>;
export type CharacterCardV3 = z.infer<typeof characterCardV3Schema>;
export type CharacterCard = CharacterCardV2 | CharacterCardV3;
