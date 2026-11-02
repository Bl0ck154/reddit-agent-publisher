import test from "node:test";
import assert from "node:assert/strict";
import { withRedditReadFallback } from "../reddit-read-transport.js";
test("read transport prefers Lightpanda without touching Chrome",async()=>{
  let fallbackCalled=false;
  const result=await withRedditReadFallback(async()=> "lightpanda",async()=>{fallbackCalled=true;return "chrome"},true);
  assert.equal(result,"lightpanda");assert.equal(fallbackCalled,false);
});
test("read transport falls back once on missing Lightpanda auth",async()=>{
  let calls=0;
  const result=await withRedditReadFallback(async()=>{throw new Error("AUTH_REQUIRED: browser session")},async()=>{calls++;return "chrome"},true);
  assert.equal(result,"chrome");assert.equal(calls,1);
});
test("rate limits never trigger another backend request",async()=>{
  let calls=0;
  await assert.rejects(withRedditReadFallback(async()=>{throw new Error("RATE_LIMITED: 429")},async()=>{calls++;return "chrome"},true),/RATE_LIMITED/);
  assert.equal(calls,0);
});
