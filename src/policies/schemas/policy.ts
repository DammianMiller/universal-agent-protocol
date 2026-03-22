import { z } from 'zod';

export const PolicySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  category: z.enum(['image', 'code', 'security', 'testing', 'ui', 'automation', 'workflow', 'custom', 'quality', 'infrastructure', 'release', 'safety']),
  level: z.enum(['REQUIRED', 'RECOMMENDED', 'OPTIONAL']),
  enforcementStage: z.enum(['pre-exec', 'post-exec', 'review', 'always']).default('pre-exec'),
  rawMarkdown: z.string(),
  convertedFormat: z.string().nullable().optional(),
  executableTools: z.array(z.string()).optional(),
  tags: z.array(z.string()),
  createdAt: z.string().refine((d) => !Number.isNaN(Date.parse(d)), {
    message: 'Invalid ISO date string',
  }),
  updatedAt: z.string().refine((d) => !Number.isNaN(Date.parse(d)), {
    message: 'Invalid ISO date string',
  }),
  version: z.number(),
  isActive: z.boolean(),
  priority: z.number().default(50), // For sorting relevance (higher = more relevant)
});

export type Policy = z.infer<typeof PolicySchema>;

export const PolicyExecutionSchema = z.object({
  policyId: z.string().uuid(),
  toolName: z.string(),
  operation: z.string(),
  args: z.record(z.unknown()),
  result: z.any(),
  executedAt: z.string().refine((d) => !Number.isNaN(Date.parse(d)), {
    message: 'Invalid ISO date string',
  }),
});

export type PolicyExecution = z.infer<typeof PolicyExecutionSchema>;
