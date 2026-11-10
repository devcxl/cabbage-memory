import { z } from "zod";

const SUBTYPES_BY_TYPE: Record<
  "daily" | "fact" | "instruction",
  readonly string[]
> = {
  daily: [],
  fact: ["preference", "episodic", "knowledge"],
  instruction: ["identity", "rule", "workflow"],
};

/** POST /api/memories 与 MCP memory_add 共用的入参校验 */
export const memoryCreateSchema = z
  .object({
    type: z.enum(["daily", "fact", "instruction"]),
    subtype: z.string().max(50).optional(),
    title: z.string().max(500).optional(),
    content: z.string().min(1).max(10000),
    scope: z.enum(["global", "project"]).optional(),
    project_id: z.string().max(200).optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    tags: z.array(z.string().max(100)).max(20).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.scope === "project" && !data.project_id?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["project_id"],
        message: "project scope requires project_id",
      });
    }
    if (data.subtype && !SUBTYPES_BY_TYPE[data.type].includes(data.subtype)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subtype"],
        message: `subtype "${data.subtype}" is not valid for type "${data.type}"`,
      });
    }
  });

/** PUT /api/memories/:id 入参校验 */
export const memoryUpdateSchema = z.object({
  title: z.string().max(500).optional(),
  content: z.string().min(1).max(10000).optional(),
  tags: z.array(z.string().max(100)).max(20).optional(),
  project_id: z.string().max(200).optional(),
});
