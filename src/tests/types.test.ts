import test from "node:test";
import assert from "node:assert/strict";
import { AdapterId, Action, PrepareInput } from "../types.js";

test("public edition accepts only the Reddit adapter", () => {
  assert.equal(AdapterId.parse("reddit"), "reddit");
  assert.throws(() => AdapterId.parse("google-maps"));
});

test("review actions are not part of the public Reddit edition", () => {
  assert.deepEqual(Action.options, ["create_post", "create_comment", "send_chat_message", "edit", "delete"]);
  assert.throws(() => Action.parse("create_review"));
});

test("prepare input requires an explicit owner command", () => {
  const input = PrepareInput.parse({
    adapter: "reddit",
    action: "create_post",
    target: { subreddit: "test" },
    content: { title: "hello" },
    owner_command: true
  });
  assert.equal(input.account, "default");
  assert.equal(input.action, "create_post");
});
