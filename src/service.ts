import crypto from "node:crypto";
import fs from "node:fs";
import type { Adapter } from "./adapters/base.js";
import { RedditBrowserAdapter } from "./adapters/reddit-browser.js";
import type { Config } from "./config.js";
import { Store } from "./db.js";
import { PublisherError } from "./errors.js";
import { DraftState, PrepareInput, envelope, type Draft, type ResultEnvelope } from "./types.js";

function digest(value: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export class PublisherService {
  readonly store: Store;
  private adapters = new Map<string, Adapter>();
  private locks = new Set<string>();
  private lastMutation = new Map<string, number>();

  constructor(private config: Config) {
    this.store = new Store(config);
    this.register(new RedditBrowserAdapter(config));
  }

  register(adapter: Adapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  async prepare(raw: unknown, actor = "cli"): Promise<ResultEnvelope> {
    try {
      const input = PrepareInput.parse(raw);
      const account = this.effectiveAccount(input.account);
      const now = new Date().toISOString();
      const draft: Draft = {
        id: crypto.randomUUID(),
        adapter: "reddit",
        account,
        action: input.action,
        target: input.target,
        content: input.content,
        state: "PREPARED",
        revision: 1,
        digest: digest({ adapter: "reddit", account, action: input.action, target: input.target, content: input.content, revision: 1 }),
        created_at: now,
        updated_at: now
      };
      await this.adapter().validate(draft);
      this.store.saveDraft(draft);
      this.store.audit("draft.prepared", actor, draft.id, { action: draft.action, digest: draft.digest });
      return envelope({
        state: draft.state,
        adapter: "reddit",
        account,
        draft_id: draft.id,
        revision: 1,
        result: { digest: draft.digest },
        next_actions: [{ tool: "publication_preview", required: true, args: { draft_id: draft.id } }]
      });
    } catch (error: any) {
      return this.fail(error);
    }
  }

  async preview(id: string, actor = "cli"): Promise<ResultEnvelope> {
    try {
      const draft = this.needDraft(id);
      this.assertState(draft, ["PREPARED", "PREVIEWED", "NEEDS_USER", "FAILED_RETRYABLE"]);
      const preview = await this.adapter().preview(draft);
      const state: DraftState = preview.requires_user ? "NEEDS_USER" : "PREVIEWED";
      this.store.updateState(id, state);
      const artifactSha = preview.artifact_path
        ? `sha256:${crypto.createHash("sha256").update(fs.readFileSync(preview.artifact_path)).digest("hex")}`
        : undefined;
      const previewDigest = digest({ draft: draft.digest, summary: preview.summary, artifactSha, revision: draft.revision });
      const expiresAt = new Date(Date.now() + this.config.approvalTtlSeconds * 1000).toISOString();
      this.store.db.prepare("INSERT INTO previews VALUES(?,?,?,?,?,?,?,?)").run(
        crypto.randomUUID(), id, draft.revision, previewDigest, JSON.stringify(preview.summary), preview.artifact_path ?? null,
        new Date().toISOString(), expiresAt
      );
      this.store.audit("draft.previewed", actor, id, { preview_digest: previewDigest, artifact: Boolean(preview.artifact_path) });
      return envelope({
        state,
        adapter: "reddit",
        account: draft.account,
        draft_id: id,
        revision: draft.revision,
        preview: {
          digest: previewDigest,
          summary: preview.summary,
          artifact_path: preview.artifact_path,
          artifact_sha256: artifactSha,
          expires_at: expiresAt
        },
        next_actions: preview.requires_user
          ? [{ tool: "auth_login", required: true }]
          : [{ tool: "owner_approve", required: true, args: { draft_id: id, preview_digest: previewDigest } }]
      });
    } catch (error: any) {
      return this.fail(error, id);
    }
  }

  async approve(id: string, previewDigest: string, confirmation: string, actor = "cli"): Promise<ResultEnvelope> {
    try {
      const draft = this.needDraft(id);
      this.assertState(draft, ["PREVIEWED"]);
      const token = this.issueApproval(draft, previewDigest, confirmation);
      await this.adapter().approved?.(draft);
      this.store.audit("draft.approved", actor, id, { digest: previewDigest, expires_at: token.expires_at });
      return envelope({
        state: "APPROVED",
        adapter: "reddit",
        account: draft.account,
        draft_id: id,
        revision: draft.revision,
        result: token,
        next_actions: [{ tool: "publication_publish", required: true, args: { draft_id: id } }]
      });
    } catch (error: any) {
      return this.fail(error, id);
    }
  }

  async publishConfirmedAction(id: string, previewDigest: string): Promise<ResultEnvelope> {
    try {
      const draft = this.needDraft(id);
      if (draft.state === "PUBLISHED") {
        const row = this.store.db.prepare("SELECT external_id, canonical_url, created_at FROM publications WHERE draft_id=? ORDER BY created_at DESC LIMIT 1").get(id) as any;
        return envelope({
          state: "PUBLISHED",
          adapter: "reddit",
          account: draft.account,
          draft_id: id,
          revision: draft.revision,
          result: { status: "PUBLISHED", already_published: true, external_id: row?.external_id, url: row?.canonical_url, published_at: row?.created_at }
        });
      }
      if (draft.state !== "PREVIEWED" && draft.state !== "APPROVED") {
        throw new Error(`INVALID_STATE: confirmed publish requires PREVIEWED/APPROVED, got ${draft.state}`);
      }
      const token = this.issueApproval(draft, previewDigest, `APPROVE ${id}`, true);
      await this.adapter().approved?.(draft);
      return await this.publish(id, token.token, "gpt-action");
    } catch (error: any) {
      return this.fail(error, id);
    }
  }

  async publish(id: string, token: string, actor = "cli"): Promise<ResultEnvelope> {
    const draft = this.store.getDraft(id);
    if (!draft) return this.fail(new Error("DRAFT_NOT_FOUND"), id);
    try {
      this.assertState(draft, ["APPROVED"]);
      const approval = this.store.db.prepare("SELECT * FROM approvals WHERE draft_id=? AND status='active' ORDER BY approved_at DESC LIMIT 1").get(id) as any;
      if (!approval || approval.revision !== draft.revision || approval.token_hash !== digest(token) || Date.parse(approval.expires_at) <= Date.now()) {
        throw new Error("APPROVAL_REQUIRED: invalid, stale, or expired token");
      }
      const lock = draft.account;
      if (this.locks.has(lock)) throw new Error("ACCOUNT_BUSY: another mutation is in progress");
      const waitMs = this.config.mutationCooldownSeconds * 1000 - (Date.now() - (this.lastMutation.get(lock) ?? 0));
      if (waitMs > 0) throw new Error(`RATE_LIMITED: retry after ${Math.ceil(waitMs / 1000)} seconds`);
      this.locks.add(lock);
      try {
        this.store.db.transaction(() => {
          const consumed = this.store.db.prepare("UPDATE approvals SET status='consumed', consumed_at=? WHERE id=? AND status='active'").run(new Date().toISOString(), approval.id);
          const claimed = this.store.db.prepare("UPDATE drafts SET state='PUBLISHING', updated_at=? WHERE id=? AND state='APPROVED'").run(new Date().toISOString(), id);
          if (consumed.changes !== 1 || claimed.changes !== 1) throw new Error("APPROVAL_STALE: publish claim failed");
        })();
        const result = await this.adapter().publish(draft);
        this.store.db.transaction(() => {
          const changed = this.store.db.prepare("UPDATE drafts SET state='PUBLISHED', updated_at=? WHERE id=? AND state='PUBLISHING'").run(new Date().toISOString(), id);
          if (changed.changes !== 1) throw new Error("INVALID_STATE: lost publishing claim");
          this.store.db.prepare("INSERT INTO publications VALUES(?,?,?,?,?,?,?)").run(
            crypto.randomUUID(), id, "reddit", draft.account, result.external_id ?? null, result.url ?? null, new Date().toISOString()
          );
        })();
        this.store.audit("publication.published", actor, id, { external_id: result.external_id, url: result.url });
        this.lastMutation.set(lock, Date.now());
        return envelope({
          state: "PUBLISHED",
          adapter: "reddit",
          account: draft.account,
          draft_id: id,
          revision: draft.revision,
          side_effect: { performed: true },
          result,
          warnings: result.warnings ?? []
        });
      } catch (error: any) {
        const current = this.store.getDraft(id);
        if (current?.state === "PUBLISHING") {
          this.store.updateState(id, String(error.message).startsWith("PUBLISH_RESULT_AMBIGUOUS") ? "FAILED_FINAL" : "FAILED_RETRYABLE");
        }
        this.store.audit("publication.failed", actor, id, { error: String(error.message).slice(0, 300) });
        return this.fail(error, id);
      } finally {
        this.locks.delete(lock);
      }
    } catch (error: any) {
      return this.fail(error, id);
    }
  }

  async login(account = "default"): Promise<ResultEnvelope> {
    try {
      const effective = this.effectiveAccount(account);
      return envelope({ adapter: "reddit", account: effective, result: await this.adapter().login(effective) });
    } catch (error: any) {
      return this.fail(error);
    }
  }

  async status(account = "default"): Promise<ResultEnvelope> {
    try {
      const effective = this.effectiveAccount(account);
      return envelope({ adapter: "reddit", account: effective, result: await this.adapter().status(effective) });
    } catch (error: any) {
      return this.fail(error);
    }
  }

  async rules(account: string, subreddit: string): Promise<ResultEnvelope> {
    try {
      return envelope({ adapter: "reddit", result: await this.adapter().rules(this.effectiveAccount(account), subreddit) });
    } catch (error: any) {
      return this.fail(error);
    }
  }

  async flairs(account: string, subreddit: string): Promise<ResultEnvelope> {
    try {
      return envelope({ adapter: "reddit", result: await this.adapter().flairs(this.effectiveAccount(account), subreddit) });
    } catch (error: any) {
      return this.fail(error);
    }
  }

  async pending(): Promise<ResultEnvelope> {
    return envelope({ result: this.store.pending().map((draft) => ({ ...draft, target: "[stored locally]", content: "[stored locally]" })) });
  }

  async diagnose(live = false): Promise<ResultEnvelope> {
    try {
      const database = this.store.db.pragma("integrity_check");
      const adapter = await this.adapter().diagnose(live);
      return envelope({ result: { database, state_dir_mode: (fs.statSync(this.config.stateDir).mode & 0o777).toString(8), cdp_endpoint: this.config.cdpUrl, adapter } });
    } catch (error: any) {
      return this.fail(error);
    }
  }

  async artifact(artifactPath: string): Promise<ResultEnvelope> {
    try {
      const root = fs.realpathSync(`${this.config.stateDir}/artifacts/`);
      const resolved = fs.realpathSync(artifactPath);
      if (!resolved.startsWith(root)) throw new Error("ARTIFACT_FORBIDDEN");
      const data = fs.readFileSync(resolved);
      if (data.length > 8_000_000) throw new Error("ARTIFACT_TOO_LARGE");
      return envelope({ result: { path: resolved, mime_type: "image/png", sha256: `sha256:${crypto.createHash("sha256").update(data).digest("hex")}`, base64: data.toString("base64") } });
    } catch (error: any) {
      return this.fail(error);
    }
  }

  private issueApproval(draft: Draft, previewDigest: string, confirmation: string, allowAlreadyApproved = false): { token: string; expires_at: string } {
    if (draft.state !== "PREVIEWED" && !(allowAlreadyApproved && draft.state === "APPROVED")) {
      throw new Error(`INVALID_STATE: expected PREVIEWED${allowAlreadyApproved ? "/APPROVED" : ""}, got ${draft.state}`);
    }
    const latest = this.store.db.prepare("SELECT * FROM previews WHERE draft_id=? AND revision=? ORDER BY created_at DESC LIMIT 1").get(draft.id, draft.revision) as any;
    if (!latest || Date.parse(latest.expires_at) <= Date.now()) throw new Error("APPROVAL_STALE: preview is missing or expired");
    if (previewDigest !== latest.digest) throw new Error("APPROVAL_STALE: preview digest does not match current draft");
    if (confirmation !== `APPROVE ${draft.id}`) throw new Error(`APPROVAL_REQUIRED: confirmation must exactly equal APPROVE ${draft.id}`);
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + this.config.approvalTtlSeconds * 1000).toISOString();
    this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE approvals SET status='revoked' WHERE draft_id=? AND status='active'").run(draft.id);
      this.store.db.prepare("INSERT INTO approvals VALUES(?,?,?,?,?,?,?,?,NULL)").run(
        crypto.randomUUID(), draft.id, draft.revision, latest.digest, digest(token), "active", new Date().toISOString(), expiresAt
      );
      if (draft.state === "PREVIEWED") {
        const changed = this.store.db.prepare("UPDATE drafts SET state='APPROVED', updated_at=? WHERE id=? AND state='PREVIEWED'").run(new Date().toISOString(), draft.id);
        if (changed.changes !== 1) throw new Error("APPROVAL_STALE: draft state changed");
      }
    })();
    return { token, expires_at: expiresAt };
  }

  private adapter(): RedditBrowserAdapter {
    const adapter = this.adapters.get("reddit");
    if (!adapter) throw new Error("Reddit adapter is not registered");
    return adapter as RedditBrowserAdapter;
  }

  private needDraft(id: string): Draft {
    const draft = this.store.getDraft(id);
    if (!draft) throw new Error("DRAFT_NOT_FOUND");
    return draft;
  }

  private assertState(draft: Draft, states: DraftState[]): void {
    if (!states.includes(DraftState.parse(draft.state))) throw new Error(`INVALID_STATE: expected ${states.join("/")}, got ${draft.state}`);
  }

  private effectiveAccount(account: string): string {
    return account === "default" || account === "reddit-main" ? this.config.defaultAccount : account;
  }

  private fail(error: Error, draftId?: string): ResultEnvelope {
    if (error instanceof PublisherError) {
      return envelope({ ok: false, draft_id: draftId, error: { code: error.code, message: error.message, details: error.details }, next_actions: error.nextActions });
    }
    const [code] = String(error.message).split(":", 1);
    return envelope({
      ok: false,
      draft_id: draftId,
      error: { code: /^[A-Z_]+$/.test(code) ? code : "INTERNAL_ERROR", message: error.message },
      next_actions: []
    });
  }
}
