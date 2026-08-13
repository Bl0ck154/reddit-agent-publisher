import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import type { Config } from "./config.js";
import type { Draft } from "./types.js";

export class Store {
  readonly db: Database.Database;

  constructor(config: Config) {
    this.db = new Database(path.join(config.stateDir, "publisher.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY,
        adapter TEXT NOT NULL,
        account TEXT NOT NULL,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL,
        revision INTEGER NOT NULL,
        digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        digest TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        FOREIGN KEY(draft_id) REFERENCES drafts(id)
      );
      CREATE TABLE IF NOT EXISTS previews (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        digest TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        artifact_path TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY(draft_id) REFERENCES drafts(id)
      );
      CREATE TABLE IF NOT EXISTS publications (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL,
        adapter TEXT NOT NULL,
        account TEXT NOT NULL,
        external_id TEXT,
        canonical_url TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        draft_id TEXT,
        metadata_json TEXT NOT NULL,
        previous_hash TEXT,
        event_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_approval
        ON approvals(draft_id, revision) WHERE status='active';
    `);
  }

  saveDraft(draft: Draft): void {
    const payload = JSON.stringify({ target: draft.target, content: draft.content });
    this.db.prepare("INSERT INTO drafts VALUES(?,?,?,?,?,?,?,?,?,?)").run(
      draft.id,
      draft.adapter,
      draft.account,
      draft.action,
      payload,
      draft.state,
      draft.revision,
      draft.digest,
      draft.created_at,
      draft.updated_at
    );
  }

  getDraft(id: string): Draft | undefined {
    const row = this.db.prepare("SELECT * FROM drafts WHERE id=?").get(id) as any;
    if (!row) return undefined;
    const payload = JSON.parse(row.payload_json) as { target: Record<string, unknown>; content: Record<string, unknown> };
    return {
      id: row.id,
      adapter: row.adapter,
      account: row.account,
      action: row.action,
      target: payload.target,
      content: payload.content,
      state: row.state,
      revision: row.revision,
      digest: row.digest,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  updateState(id: string, state: string): void {
    this.db.prepare("UPDATE drafts SET state=?, updated_at=? WHERE id=?").run(state, new Date().toISOString(), id);
  }

  pending(): Draft[] {
    return (this.db.prepare("SELECT id FROM drafts WHERE state NOT IN ('PUBLISHED','CANCELLED','EXPIRED') ORDER BY created_at DESC").all() as any[])
      .map((row) => this.getDraft(row.id)!)
      .filter(Boolean);
  }

  audit(event: string, actor: string, draftId: string | undefined, metadata: unknown): void {
    const previous = this.db.prepare("SELECT event_hash FROM audit_events ORDER BY id DESC LIMIT 1").get() as any;
    const created = new Date().toISOString();
    const safe = JSON.stringify(metadata);
    const hash = crypto.createHash("sha256").update(`${previous?.event_hash ?? ""}|${event}|${actor}|${draftId ?? ""}|${safe}|${created}`).digest("hex");
    this.db.prepare("INSERT INTO audit_events(event_type,actor,draft_id,metadata_json,previous_hash,event_hash,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(event, actor, draftId ?? null, safe, previous?.event_hash ?? null, hash, created);
  }
}
