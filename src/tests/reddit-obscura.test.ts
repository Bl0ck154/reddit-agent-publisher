import test from "node:test";
import assert from "node:assert/strict";
import { hasRedditAuthCookie, isRedditCookie } from "../external-reddit-obscura.js";

test("Reddit cookie scope excludes lookalike and unrelated domains", () => {
  assert.equal(isRedditCookie({ domain: "reddit.com" }), true);
  assert.equal(isRedditCookie({ domain: ".www.reddit.com" }), true);
  assert.equal(isRedditCookie({ domain: "reddit.com.evil.example" }), false);
  assert.equal(isRedditCookie({ domain: ".google.com" }), false);
});

test("Only Reddit session/token cookies qualify as authenticated snapshots", () => {
  assert.equal(hasRedditAuthCookie([{ domain: ".reddit.com", name: "reddit_session" }]), true);
  assert.equal(hasRedditAuthCookie([{ domain: ".reddit.com", name: "token_v2" }]), true);
  assert.equal(hasRedditAuthCookie([{ domain: ".reddit.com", name: "session_tracker" }]), false);
  assert.equal(hasRedditAuthCookie([{ domain: ".google.com", name: "reddit_session" }]), false);
});
