import { z } from "zod";
import { providerSettingsSchema, updateProviderSettingsSchema } from "./runtime.js";

export const providerTaskSchema = z.enum(["chat", "summary", "extraction", "embedding"]);
const profileId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
export const providerProfileSchema = z.object({ id: profileId, name: z.string().trim().min(1).max(100), settings: providerSettingsSchema });
export const saveProviderProfileSchema = z.object({ name: z.string().trim().min(1).max(100), settings: updateProviderSettingsSchema });
export const providerTaskAssignmentsSchema = z.object({ chat: profileId, summary: profileId.nullable(), extraction: profileId.nullable(), embedding: profileId.nullable() });
export const updateProviderTaskAssignmentsSchema = providerTaskAssignmentsSchema.partial().refine(value => Object.keys(value).length > 0);
export const providerProfilesSchema = z.object({ profiles: z.array(providerProfileSchema).min(1), tasks: providerTaskAssignmentsSchema })
  .superRefine((state, context) => {
    const ids = new Set(state.profiles.map(profile => profile.id));
    if (ids.size !== state.profiles.length) context.addIssue({ code: "custom", message: "模型连接 ID 重复。" });
    for (const [task, id] of Object.entries(state.tasks)) if (id !== null && !ids.has(id))
      context.addIssue({ code: "custom", path: ["tasks", task], message: "任务关联的模型连接不存在。" });
  });

export type ProviderTask = z.infer<typeof providerTaskSchema>;
export type ProviderProfile = z.infer<typeof providerProfileSchema>;
export type ProviderTaskAssignments = z.infer<typeof providerTaskAssignmentsSchema>;
export type ProviderProfiles = z.infer<typeof providerProfilesSchema>;
export type SaveProviderProfile = z.infer<typeof saveProviderProfileSchema>;
