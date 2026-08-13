import { z } from "zod";

export const AdapterId = z.literal("reddit");
export type AdapterId = z.infer<typeof AdapterId>;

export const Action = z.enum(["create_post", "create_comment", "edit", "delete"]);
export type Action = z.infer<typeof Action>;

export const DraftState = z.enum([
  "PREPARED",
  "PREVIEWED",
  "APPROVED",
  "PUBLISHING",
  "PUBLISHED",
  "NEEDS_USER",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
  "CANCELLED",
  "EXPIRED"
]);
export type DraftState = z.infer<typeof DraftState>;

export const PrepareInput = z.object({
  adapter: AdapterId,
  account: z.string().min(1).default("default"),
  action: Action,
  target: z.record(z.unknown()),
  content: z.record(z.unknown()).default({}),
  owner_command: z.literal(true)
});
export type PrepareInput = z.infer<typeof PrepareInput>;

export interface Draft {
  id: string;
  adapter: AdapterId;
  account: string;
  action: Action;
  target: Record<string, unknown>;
  content: Record<string, unknown>;
  state: DraftState;
  revision: number;
  digest: string;
  created_at: string;
  updated_at: string;
}

export interface ResultEnvelope {
  schema_version: "1.0";
  ok: boolean;
  request_id: string;
  state?: DraftState;
  adapter?: AdapterId;
  account?: string;
  draft_id?: string;
  revision?: number;
  side_effect: { performed: boolean };
  result?: unknown;
  preview?: unknown;
  warnings: string[];
  next_actions: Array<{ tool: string; required?: boolean; args?: Record<string, unknown> }>;
  error?: { code: string; message: string; details?: unknown };
}

export function envelope(partial: Partial<ResultEnvelope>): ResultEnvelope {
  return {
    schema_version: "1.0",
    ok: true,
    request_id: crypto.randomUUID(),
    side_effect: { performed: false },
    warnings: [],
    next_actions: [],
    ...partial
  };
}
