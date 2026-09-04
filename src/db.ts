import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import type { Config } from "./config.js";
import { open, seal } from "./crypto-store.js";
import type { Draft } from "./types.js";

export class Store {
  readonly db: Database.Database;
  private legacyPayloadJson = false;

  constructor(config: Config) {
    this.db = new Database(path.join(config.stateDir, "publisher.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY, adapter TEXT NOT NULL, account TEXT NOT NULL,
        action TEXT NOT NULL, payload_ciphertext TEXT NOT NULL, state TEXT NOT NULL,
        revision INTEGER NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, revision INTEGER NOT NULL,
        digest TEXT NOT NULL, token_hash TEXT NOT NULL, status TEXT NOT NULL,
        approved_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT,
        FOREIGN KEY(draft_id) REFERENCES drafts(id)
      );
      CREATE TABLE IF NOT EXISTS previews (
        id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, revision INTEGER NOT NULL,
        digest TEXT NOT NULL, summary_json TEXT NOT NULL, artifact_path TEXT,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        FOREIGN KEY(draft_id) REFERENCES drafts(id)
      );
      CREATE TABLE IF NOT EXISTS publications (
        id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, adapter TEXT NOT NULL, account TEXT NOT NULL,
        external_id TEXT, canonical_url TEXT, metadata_ciphertext TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mutation_intents (
        fingerprint TEXT PRIMARY KEY, adapter TEXT NOT NULL, account TEXT NOT NULL, action TEXT NOT NULL,
        transaction_key TEXT NOT NULL, draft_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL, completed_at TEXT, external_id TEXT
      );
      CREATE INDEX IF NOT EXISTS mutation_intents_expires_at ON mutation_intents(expires_at);
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, actor TEXT NOT NULL,
        draft_id TEXT, metadata_json TEXT NOT NULL, previous_hash TEXT, event_hash TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS secrets (
        key TEXT PRIMARY KEY, value_ciphertext TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_approval
        ON approvals(draft_id, revision) WHERE status='active';
    `);
    this.migrateLegacySchema();
  }

  private columns(table: string): Set<string> {
    return new Set((this.db.pragma(`table_info(${table})`) as Array<{name:string}>).map(row => row.name));
  }

  /** Upgrade v0.1.x databases in place without throwing away existing drafts/publications. */
  private migrateLegacySchema(): void {
    const drafts = this.columns("drafts");
    this.legacyPayloadJson = drafts.has("payload_json");
    if (this.legacyPayloadJson && !drafts.has("payload_ciphertext")) {
      this.db.exec("ALTER TABLE drafts ADD COLUMN payload_ciphertext TEXT");
      const rows = this.db.prepare("SELECT id,payload_json FROM drafts WHERE payload_ciphertext IS NULL").all() as Array<{id:string;payload_json:string}>;
      const update = this.db.prepare("UPDATE drafts SET payload_ciphertext=?, payload_json='{}' WHERE id=?");
      const migrate = this.db.transaction(() => {
        for (const row of rows) update.run(seal(JSON.parse(row.payload_json)), row.id);
      });
      migrate();
    }

    const publications = this.columns("publications");
    if (!publications.has("metadata_ciphertext")) {
      this.db.exec("ALTER TABLE publications ADD COLUMN metadata_ciphertext TEXT NOT NULL DEFAULT ''");
    }
  }

  saveDraft(draft: Draft): void {
    const payload = seal({ target: draft.target, content: draft.content });
    if (this.legacyPayloadJson) {
      this.db.prepare(`INSERT INTO drafts(id,adapter,account,action,payload_json,payload_ciphertext,state,revision,digest,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        draft.id, draft.adapter, draft.account, draft.action, "{}", payload, draft.state,
        draft.revision, draft.digest, draft.created_at, draft.updated_at,
      );
      return;
    }
    this.db.prepare(`INSERT INTO drafts(id,adapter,account,action,payload_ciphertext,state,revision,digest,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      draft.id, draft.adapter, draft.account, draft.action, payload, draft.state,
      draft.revision, draft.digest, draft.created_at, draft.updated_at,
    );
  }

  getDraft(id: string): Draft | undefined {
    const row = this.db.prepare("SELECT * FROM drafts WHERE id=?").get(id) as any;
    if (!row) return undefined;
    const p = row.payload_ciphertext
      ? open<{ target: Record<string, unknown>; content: Record<string, unknown> }>(row.payload_ciphertext)
      : JSON.parse(row.payload_json);
    return { id: row.id, adapter: row.adapter, account: row.account, action: row.action,
      target: p.target, content: p.content, state: row.state, revision: row.revision,
      digest: row.digest, created_at: row.created_at, updated_at: row.updated_at };
  }

  updateState(id: string, state: string): void {
    this.db.prepare("UPDATE drafts SET state=?, updated_at=? WHERE id=?").run(state, new Date().toISOString(), id);
  }

  pending(): Draft[] {
    return (this.db.prepare("SELECT id FROM drafts WHERE state NOT IN ('PUBLISHED','CANCELLED','EXPIRED') ORDER BY created_at DESC").all() as any[])
      .map((r) => this.getDraft(r.id)!).filter(Boolean);
  }

  acquireMutationIntent(input: { fingerprint:string; adapter:string; account:string; action:string; draft_id:string }, pendingTtlMs = 24 * 60 * 60_000): { transaction_key:string; reused:boolean; completed:boolean; external_id?:string; expires_at:string } {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM mutation_intents WHERE fingerprint=?").get(input.fingerprint) as any;
      if (existing && Date.parse(existing.expires_at) > nowMs) {
        this.db.prepare("UPDATE mutation_intents SET draft_id=?, updated_at=? WHERE fingerprint=?").run(input.draft_id, now, input.fingerprint);
        return { transaction_key:String(existing.transaction_key), reused:true, completed:Boolean(existing.completed_at), external_id:existing.external_id ?? undefined, expires_at:String(existing.expires_at) };
      }
      const transactionKey = `intent-${crypto.randomUUID()}`;
      const expiresAt = new Date(nowMs + pendingTtlMs).toISOString();
      this.db.prepare(`INSERT INTO mutation_intents(fingerprint,adapter,account,action,transaction_key,draft_id,created_at,updated_at,expires_at,completed_at,external_id)
        VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL)
        ON CONFLICT(fingerprint) DO UPDATE SET adapter=excluded.adapter,account=excluded.account,action=excluded.action,transaction_key=excluded.transaction_key,draft_id=excluded.draft_id,created_at=excluded.created_at,updated_at=excluded.updated_at,expires_at=excluded.expires_at,completed_at=NULL,external_id=NULL`)
        .run(input.fingerprint,input.adapter,input.account,input.action,transactionKey,input.draft_id,now,now,expiresAt);
      this.db.prepare("DELETE FROM mutation_intents WHERE expires_at<=? AND fingerprint<>?").run(now,input.fingerprint);
      return { transaction_key:transactionKey, reused:false, completed:false, expires_at:expiresAt };
    })();
  }

  completeMutationIntent(fingerprint: string, externalId?: string, completedRetryTtlMs = 5 * 60_000): void {
    const nowMs=Date.now(); const now=new Date(nowMs).toISOString(); const expiresAt=new Date(nowMs+completedRetryTtlMs).toISOString();
    this.db.prepare("UPDATE mutation_intents SET completed_at=?, external_id=?, updated_at=?, expires_at=? WHERE fingerprint=?")
      .run(now,externalId ?? null,now,expiresAt,fingerprint);
  }

  recordCompletedMutationAlias(input:{fingerprint:string;adapter:string;account:string;action:string;draft_id:string;transaction_key:string;external_id?:string}, completedRetryTtlMs = 5 * 60_000): void {
    const nowMs=Date.now(); const now=new Date(nowMs).toISOString(); const expiresAt=new Date(nowMs+completedRetryTtlMs).toISOString();
    this.db.prepare(`INSERT INTO mutation_intents(fingerprint,adapter,account,action,transaction_key,draft_id,created_at,updated_at,expires_at,completed_at,external_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(fingerprint) DO UPDATE SET adapter=excluded.adapter,account=excluded.account,action=excluded.action,transaction_key=excluded.transaction_key,draft_id=excluded.draft_id,updated_at=excluded.updated_at,expires_at=excluded.expires_at,completed_at=excluded.completed_at,external_id=excluded.external_id`)
      .run(input.fingerprint,input.adapter,input.account,input.action,input.transaction_key,input.draft_id,now,now,expiresAt,now,input.external_id ?? null);
  }

  setSecret(name: string, value: unknown): void {
    this.db.prepare("INSERT INTO secrets VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_ciphertext=excluded.value_ciphertext, updated_at=excluded.updated_at")
      .run(name, seal(value), new Date().toISOString());
  }

  getSecret<T>(name: string): T | undefined {
    const row = this.db.prepare("SELECT value_ciphertext FROM secrets WHERE key=?").get(name) as any;
    return row ? open<T>(row.value_ciphertext) : undefined;
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
