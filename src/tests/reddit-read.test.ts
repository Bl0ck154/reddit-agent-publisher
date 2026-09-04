import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalRedditThreadTarget,
  normalizeActivityPayload,
  normalizeInboxPayload,
  normalizeThreadPayload,
} from "../reddit-read.js";
import { redditUsernameFromProfileHref } from "../reddit-identity.js";

test("canonicalRedditThreadTarget accepts post and comment permalinks", () => {
  assert.deepEqual(canonicalRedditThreadTarget("https://www.reddit.com/r/test/comments/abc123/example/"), {
    subreddit: "test",
    post_id: "abc123",
    comment_id: undefined,
    canonical_url: "https://www.reddit.com/r/test/comments/abc123/",
  });
  assert.equal(
    canonicalRedditThreadTarget("https://old.reddit.com/r/test/comments/abc123/example/def456/?context=3").canonical_url,
    "https://www.reddit.com/r/test/comments/abc123/_/def456/",
  );
});

test("canonicalRedditThreadTarget rejects non-Reddit and ambiguous targets", () => {
  assert.throws(() => canonicalRedditThreadTarget("https://example.com/r/test/comments/abc123/example/"), /Only canonical HTTPS Reddit/);
  assert.throws(() => canonicalRedditThreadTarget("http://www.reddit.com/r/test/comments/abc123/example/"), /Only canonical HTTPS Reddit/);
  assert.throws(() => canonicalRedditThreadTarget("https://www.reddit.com/user/example/"), /canonical post\/comment permalink/);
});

test("normalizeThreadPayload preserves nested comment context", () => {
  const target = canonicalRedditThreadTarget("https://www.reddit.com/r/test/comments/abc123/_/def456/");
  const payload = [
    { data: { children: [{ kind: "t3", data: { id: "abc123", name: "t3_abc123", subreddit: "test", title: "Title", selftext: "Body", author: "owner", score: 10, num_comments: 2, created_utc: 1_700_000_000, permalink: "/r/test/comments/abc123/title/" } }] } },
    { data: { children: [{ kind: "t1", data: { id: "root1", name: "t1_root1", parent_id: "t3_abc123", subreddit: "test", author: "alice", body: "Root", score: 2, created_utc: 1_700_000_001, permalink: "/r/test/comments/abc123/title/root1/", replies: { data: { children: [{ kind: "t1", data: { id: "def456", name: "t1_def456", parent_id: "t1_root1", subreddit: "test", author: "bob", body: "Target", score: 3, created_utc: 1_700_000_002, permalink: "/r/test/comments/abc123/title/def456/", replies: "" } }] } } } }] } },
  ];
  const result = normalizeThreadPayload(payload, target);
  assert.equal(result.returned_comments, 2);
  assert.equal((result.target_comment as Record<string, unknown>).body, "Target");
  assert.equal(((result.comments as Record<string, unknown>[])[0].replies as Record<string, unknown>[])[0].depth, 1);
});

test("normalizeActivityPayload distinguishes posts and comments", () => {
  const items = normalizeActivityPayload({ data: { children: [
    { kind: "t3", data: { id: "p1", title: "Post", subreddit: "test", author: "me", selftext: "Text", permalink: "/r/test/comments/p1/post/", created_utc: 1_700_000_000 } },
    { kind: "t1", data: { id: "c1", body: "Comment", subreddit: "test", author: "me", permalink: "/r/test/comments/p1/post/c1/", created_utc: 1_700_000_001, link_id: "t3_p1", link_title: "Post" } },
  ] } });
  assert.deepEqual(items.map(item => item.type), ["post", "comment"]);
});

test("normalizeInboxPayload exposes unread replies", () => {
  const items = normalizeInboxPayload({ data: { children: [
    { kind: "t4", data: { id: "m1", name: "t4_m1", subject: "comment reply", author: "alice", body: "Hi", new: true, was_comment: true, context: "/r/test/comments/p1/post/c1/", created_utc: 1_700_000_000 } },
  ] } });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "reply");
  assert.equal(items[0].unread, true);
  assert.equal(items[0].context, "https://www.reddit.com/r/test/comments/p1/post/c1/");
});

test("normalizeThreadPayload exposes deterministic top/newest/oldest top-level comment shortcuts", () => {
  const target = canonicalRedditThreadTarget("https://www.reddit.com/r/test/comments/abc123/example/");
  const payload = [
    { data: { children: [{ kind: "t3", data: { id: "abc123", name: "t3_abc123", subreddit: "test", title: "Title", selftext: "Body", author: "owner", score: 10, num_comments: 3, created_utc: 1_700_000_000, permalink: "/r/test/comments/abc123/title/" } }] } },
    { data: { children: [
      { kind: "t1", data: { id: "root1", name: "t1_root1", parent_id: "t3_abc123", subreddit: "test", author: "alice", body: "Older root", score: 2, created_utc: 1_700_000_001, permalink: "/r/test/comments/abc123/title/root1/", replies: { data: { children: [{ kind: "t1", data: { id: "nested", name: "t1_nested", parent_id: "t1_root1", subreddit: "test", author: "nested", body: "Nested with huge score", score: 999, created_utc: 1_700_000_002, permalink: "/r/test/comments/abc123/title/nested/", replies: "" } }] } } } },
      { kind: "t1", data: { id: "root2", name: "t1_root2", parent_id: "t3_abc123", subreddit: "test", author: "bob", author_fullname: "t2_bob123", body: "Top root", score: 7, created_utc: 1_700_000_003, permalink: "/r/test/comments/abc123/title/root2/", replies: "" } },
    ] } },
  ];
  const result = normalizeThreadPayload(payload, target);
  assert.equal((result.top_comment as Record<string, unknown>).id, "root2");
  assert.equal((result.top_comment as Record<string, unknown>).author_fullname, "t2_bob123");
  assert.equal((result.oldest_comment as Record<string, unknown>).id, "root1");
  assert.equal((result.newest_comment as Record<string, unknown>).id, "root2");
  assert.equal((result.top_comment as Record<string, unknown>).permalink, "https://www.reddit.com/r/test/comments/abc123/title/root2/");
});

test("Reddit username parser accepts only exact profile links", () => {
  assert.equal(redditUsernameFromProfileHref("/user/EfficiencyGood4815/"), "EfficiencyGood4815");
  assert.equal(redditUsernameFromProfileHref("/user/stadt_wien/comments/abc123/title/"), undefined);
  assert.equal(redditUsernameFromProfileHref("https://www.reddit.com/user/example/"), undefined);
});
