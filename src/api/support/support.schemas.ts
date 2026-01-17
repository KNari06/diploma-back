import { z } from 'zod';

/**
 * Schema for submitting a user report
 */
export const submitReportSchema = z.object({
  title: z
    .string()
    .min(1, 'Title is required')
    .max(200, 'Title must be 200 characters or less')
    .trim(),
  category: z.enum(['bug', 'ui', 'feature', 'other'], {
    errorMap: () => ({ message: 'Category must be one of: bug, ui, feature, other' }),
  }),
  details: z
    .string()
    .min(1, 'Details are required')
    .max(500, 'Details must be 500 characters or less')
    .trim(),
  workspace_name: z
    .string()
    .max(255, 'Workspace name must be 255 characters or less')
    .optional(),
  view: z
    .string()
    .max(255, 'View must be 255 characters or less')
    .optional(),
});

export type SubmitReportRequest = z.infer<typeof submitReportSchema>;
