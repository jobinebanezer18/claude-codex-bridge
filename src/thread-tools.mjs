import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const threadLink = (id) => `codex://threads/${encodeURIComponent(id)}`;
export const threadId = z.string().uuid();
export const threadTitle = z.string().trim().min(1).max(160);
export const listThreadFields = {
  query: z.string().trim().max(240).optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(100).optional(),
};
export const createThreadFields = {
  title: threadTitle,
  cwd: z.string().refine(isAbsolute, 'Enter an absolute workspace path.').optional(),
  pairAsX1: z.boolean().optional(),
  requestKey: z.string().trim().min(1).max(128),
};
export const pairThreadFields = { threadId };
export const renameThreadFields = { title: threadTitle };
export const projectId = z.string().uuid();
export const alias = z.string().trim().min(1).max(64).regex(/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u, 'Use a name with letters, numbers, spaces, dots, underscores, or hyphens.');
export const teamSetFields = {
  alias,
  role: z.enum(['project-lead', 'codex-lead', 'worker']),
  threadId: threadId.optional(),
  expectedThreadId: threadId.optional(),
};
export const workFields = {
  limit: z.number().int().min(1).max(100).default(25),
  before: z.number().int().positive().optional(),
  workerBefore: z.number().int().positive().optional(),
  includeClosed: z.boolean().default(false),
};
export const recoveryFields = {
  previousClaudeSession: threadId.optional(),
  codexThreadId: threadId.optional(),
  previousCodexThreadId: threadId.optional(),
  transferIds: z.array(threadId).max(100).default([]),
  prepareMonitor: z.boolean().default(true),
};

export const sendThreadFields = {
  threadId,
  message: z.string().trim().min(1).max(24000),
  delivery: z.enum(['live', 'inbox']).default('live'),
  requestKey: z.string().trim().min(1).max(128).optional(),
};
