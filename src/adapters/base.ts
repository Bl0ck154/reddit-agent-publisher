import type { Draft } from "../types.js";

export interface PreviewData {
  summary: Record<string, unknown>;
  artifact_path?: string;
  requires_user?: boolean;
}

export interface PublishData {
  external_id?: string;
  url?: string;
  status: string;
  warnings?: string[];
}

export interface Adapter {
  readonly id: string;
  validate(draft: Draft): Promise<void>;
  preview(draft: Draft): Promise<PreviewData>;
  publish(draft: Draft): Promise<PublishData>;
  login(account: string): Promise<Record<string, unknown>>;
  status(account: string): Promise<Record<string, unknown>>;
  diagnose(live: boolean): Promise<Record<string, unknown>>;
  /** Optional hook for browser adapters that must keep an exact live preview alive after approval. */
  approved?(draft: Draft): Promise<void> | void;
}
