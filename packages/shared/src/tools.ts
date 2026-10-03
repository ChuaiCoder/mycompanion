import { z } from "zod";

/** Tool callbacks execute in the actual extension document. Only their data
 * crosses to the model service; callback functions are never deserialized. */
export const toolInvocationSchema = z.object({
  id: z.string(), name: z.string(), displayName: z.string().optional(),
  parameters: z.string(), result: z.string().default(""), error: z.boolean().optional(),
  signature: z.string().nullable().optional(), reasoning: z.string().nullable().optional(),
});
export const toolInvocationResultSchema = z.object({
  invocations: z.array(toolInvocationSchema), stealthCalls: z.array(z.string()),
  errors: z.array(z.object({message: z.string(), cause: z.string().optional()})),
});
export type ToolInvocation = z.infer<typeof toolInvocationSchema>;
export type ToolInvocationResult = z.infer<typeof toolInvocationResultSchema>;
