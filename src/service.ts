import crypto from "node:crypto";
import fs from "node:fs";
import type { Adapter } from "./adapters/base.js";
import { RedditBrowserAdapter } from "./adapters/reddit-browser.js";
import type { Config } from "./config.js";
import { digest } from "./crypto-store.js";
import { Store } from "./db.js";
import { PublisherError } from "./errors.js";
import { DraftState, PrepareInput, envelope, type Draft, type ResultEnvelope } from "./types.js";

export class PublisherService {
  readonly store: Store;
  private adapters: Map<string, Adapter>;
  private locks = new Set<string>();
  private lastMutation = new Map<string, number>();
  constructor(private config: Config) {
    this.store = new Store(config);
    this.adapters = new Map();
    this.register(new RedditBrowserAdapter(config));
  }
  register(adapter: Adapter): void { this.adapters.set(adapter.id, adapter); }

  async prepare(raw: unknown, actor = "cli"): Promise<ResultEnvelope> {
    try {
      const input = PrepareInput.parse(raw);
      const account = this.effectiveAccount(input.adapter, input.account);
      const now = new Date().toISOString();
      const draft: Draft = { id: crypto.randomUUID(), adapter: input.adapter, account,
        action: input.action, target: input.target, content: input.content, state: "PREPARED", revision: 1,
        digest: digest({ adapter: input.adapter, account: input.account, action: input.action, target: input.target, content: input.content, revision: 1 }),
        created_at: now, updated_at: now };
      await this.adapter(draft.adapter).validate(draft); this.store.saveDraft(draft);
      this.store.audit("draft.prepared", actor, draft.id, { adapter: draft.adapter, action: draft.action, digest: draft.digest });
      return envelope({ state: draft.state, adapter: draft.adapter, account: draft.account, draft_id: draft.id, revision: 1,
        result: { digest: draft.digest }, next_actions: [{ tool: "publication_preview", required: true, args: { draft_id: draft.id } }] });
    } catch (e: any) { return this.fail(e); }
  }

  async preview(id: string, actor = "cli"): Promise<ResultEnvelope> {
    try {
      const stored = this.needDraft(id); this.assertState(stored, ["PREPARED", "PREVIEWED", "NEEDS_USER", "FAILED_RETRYABLE"]);
      const d = this.withEffectiveAccount(stored);
      const p = await this.adapter(d.adapter).preview(d); this.store.updateState(id, p.requires_user ? "NEEDS_USER" : "PREVIEWED");
      const artifact_sha256 = p.artifact_path ? `sha256:${crypto.createHash("sha256").update(fs.readFileSync(p.artifact_path)).digest("hex")}` : undefined;
      const pd = digest({ draft: d.digest, summary: p.summary, artifact_sha256, revision: d.revision });
      const expires = new Date(Date.now() + this.config.approvalTtlSeconds * 1000).toISOString();
      this.store.db.prepare("INSERT INTO previews VALUES(?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), id, d.revision, pd, JSON.stringify(p.summary), p.artifact_path ?? null, new Date().toISOString(), expires);
      this.store.audit("draft.previewed", actor, id, { preview_digest: pd, artifact: Boolean(p.artifact_path) });
      return envelope({ state: p.requires_user ? "NEEDS_USER" : "PREVIEWED", adapter: d.adapter, account: d.account,
        draft_id: id, revision: d.revision, preview: { digest: pd, summary: p.summary, artifact_path: p.artifact_path, artifact_sha256, expires_at: expires },
        next_actions: p.requires_user ? [{ tool: "auth_login", required: true }] : [{ tool: "owner_cli_approve", required: true, args: { draft_id: id, preview_digest: pd } }] });
    } catch (e: any) {
      try { this.store.audit("draft.preview_failed", actor, id, { code: e?.code ?? undefined, error: String(e?.message ?? e).slice(0, 500) }); } catch {}
      return this.fail(e, id);
    }
  }

  async approve(id: string, previewDigest: string, confirmation: string, actor = "cli"): Promise<ResultEnvelope> {
    try {
      if (actor !== "cli" && actor !== "mcp") throw new Error("APPROVAL_REQUIRED: approval is available through the owner CLI or an explicit MCP confirmation");
      const d = this.needDraft(id); this.assertState(d, ["PREVIEWED"]);
      const token = this.issueApproval(d, previewDigest, confirmation);
      const effective = this.withEffectiveAccount(d);
      try { await this.adapter(effective.adapter).approved?.(effective); }
      catch (leaseError: any) { this.store.audit("browser.lease_renew_failed", actor, id, { error: String(leaseError?.message ?? leaseError).slice(0, 200) }); }
      this.store.audit("draft.approved", actor, id, { digest: previewDigest, expires_at: token.expires_at });
      return envelope({ state: "APPROVED", adapter: d.adapter, account: effective.account, draft_id: id, revision: d.revision,
        result: { approval_token: token.token, expires_at: token.expires_at }, next_actions: [{ tool: "publication_publish", required: true, args: { draft_id: id } }] });
    } catch (e: any) { return this.fail(e, id); }
  }

  /**
   * Dedicated bridge for a GPT Action that ChatGPT has already presented to the user as
   * a consequential operation. It can only publish the exact, still-valid preview digest.
   * CLI/MCP approval semantics remain unchanged.
   */
  async publishConfirmedAction(id: string, previewDigest: string, actor = "gpt-action"): Promise<ResultEnvelope> {
    try {
      if (actor !== "gpt-action") throw new Error("APPROVAL_REQUIRED: confirmed Action publishing is restricted to the GPT Actions gateway");
      const stored = this.needDraft(id);
      const d = this.withEffectiveAccount(stored);

      if (d.state === "PUBLISHED") {
        const publication = this.store.db.prepare("SELECT external_id, canonical_url, created_at FROM publications WHERE draft_id=? ORDER BY created_at DESC LIMIT 1").get(id) as any;
        return envelope({ state: "PUBLISHED", adapter: d.adapter, account: d.account, draft_id: id, revision: d.revision,
          side_effect: { performed: false }, result: { status: "PUBLISHED", action: d.action, already_published: true,
            external_id: publication?.external_id ?? undefined, url: publication?.canonical_url ?? undefined, published_at: publication?.created_at ?? undefined } });
      }

      if (d.state !== "PREVIEWED" && d.state !== "APPROVED") throw new Error(`INVALID_STATE: confirmed Action publish requires PREVIEWED/APPROVED, got ${d.state}`);
      const token = this.issueApproval(d, previewDigest, `APPROVE ${id}`, true);
      try { await this.adapter(d.adapter).approved?.(d); }
      catch (leaseError: any) { this.store.audit("browser.lease_renew_failed", actor, id, { error: String(leaseError?.message ?? leaseError).slice(0, 200) }); }
      this.store.audit("draft.approved", actor, id, { digest: previewDigest, expires_at: token.expires_at, source: "gpt-action" });
      const published = await this.publish(id, token.token, actor);
      if (!published.ok) return published;
      const result = (published.result && typeof published.result === "object") ? published.result as Record<string, unknown> : {};
      return { ...published, result: { ...result, action: d.action } };
    } catch (e: any) { return this.fail(e, id); }
  }

  async publish(id: string, token: string, actor = "cli"): Promise<ResultEnvelope> {
    const stored = this.store.getDraft(id);
    if (!stored) return this.fail(new Error("DRAFT_NOT_FOUND"), id);
    const d = this.withEffectiveAccount(stored);
    try { this.assertState(d,["APPROVED"]); } catch(e:any){ return this.fail(e,id); }
    const a = this.store.db.prepare("SELECT * FROM approvals WHERE draft_id=? AND status='active' ORDER BY approved_at DESC LIMIT 1").get(id) as any;
    if (!a || a.revision !== d.revision || a.token_hash !== digest(token) || Date.parse(a.expires_at) <= Date.now()) return this.fail(new Error("APPROVAL_REQUIRED: invalid, stale, or expired token"),id);
    const lock = d.account;
    if (this.locks.has(lock)) return this.fail(new Error("ACCOUNT_BUSY: another mutation is in progress"), id);
    const waitMs = this.config.mutationCooldownSeconds * 1000 - (Date.now() - (this.lastMutation.get(lock) ?? 0));
    this.locks.add(lock);
    try {
      // The cooldown is an internal pacing guard, not an error the caller should
      // have to recover from. Keep the account lock while waiting so a batch of
      // owner-approved writes remains serialized, then continue the same publish.
      if (waitMs > 0) {
        await new Promise(resolve => setTimeout(resolve, waitMs));
        if (Date.parse(a.expires_at) <= Date.now()) return this.fail(new Error("APPROVAL_REQUIRED: approval expired while waiting for publisher cooldown"), id);
      }
      this.store.db.transaction(()=>{
        const consumed=this.store.db.prepare("UPDATE approvals SET status='consumed', consumed_at=? WHERE id=? AND status='active'").run(new Date().toISOString(),a.id);
        const claimed=this.store.db.prepare("UPDATE drafts SET state='PUBLISHING', updated_at=? WHERE id=? AND state='APPROVED'").run(new Date().toISOString(),id);
        if(consumed.changes!==1||claimed.changes!==1) throw new Error("APPROVAL_STALE: publish claim failed");
      })();
      const r = await this.adapter(d.adapter).publish(d);
      this.store.db.transaction(()=>{
        const changed=this.store.db.prepare("UPDATE drafts SET state='PUBLISHED', updated_at=? WHERE id=? AND state='PUBLISHING'").run(new Date().toISOString(),id);
        if(changed.changes!==1) throw new Error("INVALID_STATE: lost publishing claim");
        this.store.db.prepare("INSERT INTO publications(id,draft_id,adapter,account,external_id,canonical_url,metadata_ciphertext,created_at) VALUES(?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), id, d.adapter, d.account, r.external_id ?? null, r.url ?? null, "", new Date().toISOString());
      })();
      this.store.audit("publication.published", actor, id, { external_id: r.external_id, url: r.url });
      this.lastMutation.set(lock, Date.now());
      return envelope({ state: "PUBLISHED", adapter: d.adapter, account: d.account, draft_id: id, revision: d.revision,
        side_effect: { performed: true }, result: r, warnings: r.warnings ?? [] });
    } catch (e: any) { const current=this.store.getDraft(id); if(current?.state==="PUBLISHING") this.store.updateState(id,String(e.message).startsWith("PUBLISH_RESULT_AMBIGUOUS")?"FAILED_FINAL":"FAILED_RETRYABLE"); this.store.audit("publication.failed", actor, id, { error: String(e.message).slice(0, 300) }); return this.fail(e, id); }
    finally { this.locks.delete(lock); }
  }

  async login(adapterId: string, account: string, extra: Record<string,string> = {}): Promise<ResultEnvelope> {
    try { const a = this.adapter(adapterId); let result: unknown; const effective=this.effectiveAccount(adapterId,account);
      result = await a.login(effective);
      return envelope({ adapter: adapterId as any, account:effective, result });
    } catch (e: any) { return this.fail(e); }
  }

  async status(adapterId?: string, account = "default"): Promise<ResultEnvelope> {
    try { const entries = adapterId ? [[adapterId, await this.adapter(adapterId).status(this.effectiveAccount(adapterId,account))]] : await Promise.all([...this.adapters].map(async ([id,a]) => [id, await a.status(this.effectiveAccount(id,account))]));
      return envelope({ result: Object.fromEntries(entries as any) }); } catch (e: any) { return this.fail(e); }
  }

  async pending(): Promise<ResultEnvelope> { return envelope({ result: this.store.pending().map(d => ({ ...d, target: "[encrypted]", content: "[encrypted]" })) }); }

  async rules(account: string, subreddit: string): Promise<ResultEnvelope> { try { return envelope({ adapter: "reddit", result: await (this.adapter("reddit") as RedditBrowserAdapter).rules(this.effectiveAccount("reddit",account), subreddit) }); } catch(e:any){return this.fail(e);} }
  async flairs(account: string, subreddit: string): Promise<ResultEnvelope> { try { return envelope({ adapter: "reddit", result: await (this.adapter("reddit") as RedditBrowserAdapter).flairs(this.effectiveAccount("reddit",account), subreddit) }); } catch(e:any){return this.fail(e);} }
  async diagnose(live = false): Promise<ResultEnvelope> {
    try { const db = this.store.db.pragma("integrity_check"); const adapters = await Promise.all([...this.adapters.values()].map(a => a.diagnose(live)));
      return envelope({ result: { database: db, state_dir_mode: (fs.statSync(this.config.stateDir).mode & 0o777).toString(8), socket: this.config.socketPath, adapters } }); }
    catch(e:any){ return this.fail(e); }
  }

  async artifact(artifactPath:string):Promise<ResultEnvelope>{try{const root=`${this.config.stateDir}/artifacts/`;const resolved=fs.realpathSync(artifactPath);if(!resolved.startsWith(fs.realpathSync(root)))throw new Error("ARTIFACT_FORBIDDEN");const data=fs.readFileSync(resolved);if(data.length>8_000_000)throw new Error("ARTIFACT_TOO_LARGE");return envelope({result:{path:resolved,mime_type:"image/png",sha256:`sha256:${crypto.createHash("sha256").update(data).digest("hex")}`,base64:data.toString("base64")}});}catch(e:any){return this.fail(e);}}

  private issueApproval(d: Draft, previewDigest: string, confirmation: string, allowAlreadyApproved = false): { token: string; expires_at: string } {
    if (d.state !== "PREVIEWED" && !(allowAlreadyApproved && d.state === "APPROVED")) throw new Error(`INVALID_STATE: expected PREVIEWED${allowAlreadyApproved ? "/APPROVED" : ""}, got ${d.state}`);
    const latest = this.store.db.prepare("SELECT * FROM previews WHERE draft_id=? AND revision=? ORDER BY created_at DESC LIMIT 1").get(d.id, d.revision) as any;
    if (!latest || Date.parse(latest.expires_at) <= Date.now()) throw new Error("APPROVAL_STALE: preview is missing or expired");
    if (previewDigest !== latest.digest) throw new Error("APPROVAL_STALE: preview digest does not match current draft");
    if (confirmation !== `APPROVE ${d.id}`) throw new Error(`APPROVAL_REQUIRED: confirmation must exactly equal APPROVE ${d.id}`);

    const token = crypto.randomBytes(32).toString("base64url");
    const expires_at = new Date(Date.now() + this.config.approvalTtlSeconds * 1000).toISOString();
    this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE approvals SET status='revoked' WHERE draft_id=? AND status='active'").run(d.id);
      this.store.db.prepare("INSERT INTO approvals VALUES(?,?,?,?,?,?,?,?,NULL)").run(crypto.randomUUID(), d.id, d.revision, latest.digest, digest(token), "active", new Date().toISOString(), expires_at);
      if (d.state === "PREVIEWED") {
        const changed=this.store.db.prepare("UPDATE drafts SET state='APPROVED', updated_at=? WHERE id=? AND state='PREVIEWED'").run(new Date().toISOString(),d.id);
        if(changed.changes!==1) throw new Error("APPROVAL_STALE: draft state changed");
      }
    })();
    return { token, expires_at };
  }

  private adapter(id: string): Adapter { const a = this.adapters.get(id); if (!a) throw new Error(`Unknown adapter: ${id}`); return a; }
  private needDraft(id: string): Draft { const d = this.store.getDraft(id); if (!d) throw new Error("DRAFT_NOT_FOUND"); return d; }
  private assertState(d: Draft, states: DraftState[]): void { if (!states.includes(DraftState.parse(d.state))) throw new Error(`INVALID_STATE: expected ${states.join("/")}, got ${d.state}`); }
  private effectiveAccount(adapter:string,account:string):string {
    if (account === "default" || account === "reddit-main" || account === "owner-main") return this.config.defaultAccount;
    return account;
  }
  private withEffectiveAccount(d:Draft):Draft { return {...d,account:this.effectiveAccount(d.adapter,d.account)}; }
  private fail(e: Error, draftId?: string): ResultEnvelope {
    if(e instanceof PublisherError)return envelope({ok:false,draft_id:draftId,error:{code:e.code,message:e.message,details:e.details},next_actions:e.nextActions});
    const [code] = String(e.message).split(":",1); return envelope({ ok:false, draft_id:draftId, error:{ code: /^[A-Z_]+$/.test(code) ? code : "INTERNAL_ERROR", message:e.message }, next_actions:[] });
  }
}
