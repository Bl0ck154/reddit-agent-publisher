import test from "node:test";
import assert from "node:assert/strict";
import { RedditBrowserAdapter } from "../adapters/reddit-browser.js";
import type { Config } from "../config.js";

function mockAdapter(): any {
  const adapter = new RedditBrowserAdapter({} as Config) as any;
  adapter.anyVisible=async()=>true;
  return adapter;
}
function mockPage(verified: boolean, blocked=false): any {
  return {
    url:()=> "https://www.reddit.com/",
    title:async()=> blocked ? "Blocked" : "Reddit - The heart of the internet",
    locator:()=>({innerText:async()=>blocked?"Blocked by network security":"Welcome to Reddit Log In"}),
    evaluate:async()=>verified
  };
}
test("logged-in Reddit API identity overrides misleading Log In button",async()=>{
  const adapter=mockAdapter();
  assert.equal(await adapter.gate(mockPage(true)),undefined);
});
test("unauthenticated session remains blocked despite cookie/UI appearance",async()=>{
  const adapter=mockAdapter();
  assert.match(await adapter.gate(mockPage(false)),/AUTH_REQUIRED/);
});
test("network block takes priority over claimed identity",async()=>{
  const adapter=mockAdapter();
  assert.match(await adapter.gate(mockPage(true,true)),/TAKEOVER_REQUIRED/);
});
test("Modmail rejects user DMs, empty content and non-subreddit targets",async()=>{
  const adapter=mockAdapter();
  const base={adapter:"reddit",action:"send_modmail",account:"owner-main",target:{subreddit:"example"},content:{subject:"Subject",body:"Body"}};
  await adapter.validate(base);
  await assert.rejects(adapter.validate({...base,target:{...base.target,recipient_username:"other"}}),/Modmail must target/);
  await assert.rejects(adapter.validate({...base,content:{subject:"",body:"Body"}}),/subject/);
  await assert.rejects(adapter.validate({...base,target:{subreddit:"!"}}),/Invalid subreddit/);
});

test("repeated status reads cannot revoke a verified Reddit API identity because of a Log In link",async()=>{
  const adapter=mockAdapter();
  const page=mockPage(true);
  adapter.page=async()=>page;
  adapter.releasePage=async()=>{};
  adapter.browserLabel=()=> "lightpanda";
  adapter.cookieAuthenticated=async()=>true;
  adapter.detectUsername=async()=> "verified";
  adapter.unpinBackend=()=>{};
  for(let i=0;i<8;i++){
    const status=await adapter.status("owner-main");
    assert.equal(status.authenticated,true,"status attempt "+i);
    assert.equal(status.backend,"lightpanda");
  }
});
