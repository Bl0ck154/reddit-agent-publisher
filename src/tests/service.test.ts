import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Adapter, PreviewData, PublishData } from "../adapters/base.js";
import type { Config } from "../config.js";
import { PublisherService } from "../service.js";
import type { Draft } from "../types.js";

process.env.NODE_ENV = "test";

class FakeRedditAdapter implements Adapter {
  readonly id = "reddit";
  published = 0;

  async validate(_draft: Draft): Promise<void> {}

  async preview(draft: Draft): Promise<PreviewData> {
    return {
      summary: {
        action: draft.action,
        target: draft.target,
        content: draft.content
      }
    };
  }

  async publish(_draft: Draft): Promise<PublishData> {
    this.published += 1;
    return {
      status: "PUBLISHED",
      external_id: `fake-${this.published}`,
      url: `https://www.reddit.com/r/test/comments/fake${this.published}/`
    };
  }

  async login(account: string): Promise<Record<string, unknown>> {
    return { authenticated: true, account };
  }

  async status(account: string): Promise<Record<string, unknown>> {
    return { authenticated: true, account };
  }

  async diagnose(_live: boolean): Promise<Record<string, unknown>> {
    return { adapter: "reddit", ok: true };
  }
}

function makeConfig(options: { ttl?: number; cooldown?: number; accountAliases?: Record<string,string> } = {}): Config {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "reddit-agent-publisher-test-"));
  return {
    stateDir,
    socketPath: path.join(stateDir, "publisher.sock"),
    chromePath: "/missing/chrome",
    display: ":98",
    cdpUrl: "http://127.0.0.1:9222",
    approvalTtlSeconds: options.ttl ?? 900,
    mutationCooldownSeconds: options.cooldown ?? 0,
    browserIdleSeconds: 90,
    redditMetadataCacheSeconds: 900,
    actionsHost: "127.0.0.1",
    actionsPort: 8791,
    defaultAccount: "default",
    accountAliases: options.accountAliases ?? {},
    browserServicePrefix: "reddit-agent-publisher-browser"
  };
}

function makePublisher(options: { ttl?: number; cooldown?: number; accountAliases?: Record<string,string> } = {}) {
  const publisher = new PublisherService(makeConfig(options));
  const adapter = new FakeRedditAdapter();
  publisher.register(adapter);
  return { publisher, adapter };
}

async function prepareAndPreview(publisher: PublisherService, suffix = "one") {
  const prepared = await publisher.prepare({
    adapter: "reddit",
    account: "default",
    action: "create_post",
    target: { subreddit: "test" },
    content: { title: `hello-${suffix}`, body: `body-${suffix}` },
    owner_command: true
  });
  assert.equal(prepared.ok, true);
  assert.ok(prepared.draft_id);

  const previewed = await publisher.preview(prepared.draft_id!);
  assert.equal(previewed.ok, true);
  const preview = previewed.preview as { digest: string };
  assert.match(preview.digest, /^sha256:[a-f0-9]{64}$/);
  return { id: prepared.draft_id!, digest: preview.digest };
}

async function approve(publisher: PublisherService, id: string, digest: string) {
  const approved = await publisher.approve(id, digest, `APPROVE ${id}`);
  assert.equal(approved.ok, true);
  const result = approved.result as { approval_token: string; expires_at: string };
  assert.ok(result.approval_token);
  return result.approval_token;
}


test("configured Reddit username alias resolves to the connected publisher profile", async () => {
  const { publisher } = makePublisher({ accountAliases: { EfficiencyGood4815: "default" } });
  const prepared = await publisher.prepare({ adapter: "reddit", account: "efficiencygood4815", action: "create_post", target: { subreddit: "test" }, content: { title: "alias" }, owner_command: true });
  assert.equal(prepared.account, "default");
});

test("approval is bound to the exact preview digest", async () => {
  const { publisher } = makePublisher();
  const { id } = await prepareAndPreview(publisher);

  const result = await publisher.approve(id, `sha256:${"0".repeat(64)}`, `APPROVE ${id}`);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "APPROVAL_STALE");
});

test("approval requires the exact confirmation phrase", async () => {
  const { publisher } = makePublisher();
  const { id, digest } = await prepareAndPreview(publisher);

  const result = await publisher.approve(id, digest, "yes");
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "APPROVAL_REQUIRED");
});

test("expired previews cannot be approved", async () => {
  const { publisher } = makePublisher({ ttl: -1 });
  const { id, digest } = await prepareAndPreview(publisher);

  const result = await publisher.approve(id, digest, `APPROVE ${id}`);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "APPROVAL_STALE");
});

test("an approval token can execute a draft only once", async () => {
  const { publisher, adapter } = makePublisher();
  const { id, digest } = await prepareAndPreview(publisher);
  const token = await approve(publisher, id, digest);

  const first = await publisher.publish(id, token);
  assert.equal(first.ok, true);
  assert.equal(first.state, "PUBLISHED");
  assert.equal(first.side_effect.performed, true);
  assert.equal(adapter.published, 1);

  const second = await publisher.publish(id, token);
  assert.equal(second.ok, false);
  assert.equal(second.error?.code, "INVALID_STATE");
  assert.equal(adapter.published, 1);
});

test("account cooldown is absorbed internally for back-to-back mutations", async () => {
  const { publisher, adapter } = makePublisher({ cooldown: 0.05 });
  const firstDraft = await prepareAndPreview(publisher, "first");
  const secondDraft = await prepareAndPreview(publisher, "second");
  const firstToken = await approve(publisher, firstDraft.id, firstDraft.digest);
  const secondToken = await approve(publisher, secondDraft.id, secondDraft.digest);

  const first = await publisher.publish(firstDraft.id, firstToken);
  assert.equal(first.ok, true);

  const second = await publisher.publish(secondDraft.id, secondToken);
  assert.equal(second.ok, true);
  assert.equal(second.error?.code, undefined);
  assert.equal(adapter.published, 2);
});
