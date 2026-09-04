import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Adapter } from "../adapters/base.js";
import { ensureState, type Config } from "../config.js";
import { isFinalPublishFailure, PublisherService } from "../service.js";
import type { Draft } from "../types.js";
import { PublisherError } from "../errors.js";

process.env.NODE_ENV = "test";
class FakeReddit implements Adapter {
  readonly id = "reddit"; publishes = 0; executionKeys:string[]=[];
  async validate(_: Draft) {}
  async preview(d: Draft) { return { summary:{title:d.content.title,notice:"not published"} }; }
  async publish(d: Draft) { this.publishes++; if(d.execution?.idempotency_key)this.executionKeys.push(d.execution.idempotency_key); return {status:"PUBLISHED",external_id:"$matrix_event_dryrun",url:"https://example.invalid/dryrun",idempotency_alias_target:"room:!peerroom:reddit.com"}; }
  async login(_: string) { return {status:"USER_ACTION_REQUIRED"}; }
  async status(_: string) { return {authenticated:false}; }
  async diagnose(_: boolean) { return {ok:true}; }
}
function setup() {
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),"agent-publisher-test-"));
  const config:Config={stateDir,socketPath:path.join(stateDir,"sock"),chromePath:"/missing/chrome",display:":98",approvalTtlSeconds:900,mutationCooldownSeconds:0,browserIdleSeconds:90,redditMetadataCacheSeconds:900,actionsHost:"127.0.0.1",actionsPort:8791,defaultAccount:"owner-main",browserServicePrefix:"reddit-agent-publisher-browser",cdpUrl:"http://127.0.0.1:9222"};
  ensureState(config); const service=new PublisherService(config); const fake=new FakeReddit(); service.register(fake); return {service,fake,stateDir};
}
test("prepare -> preview -> explicit MCP approval -> one publish",async()=>{const {service,fake,stateDir}=setup();
  const prepared=await service.prepare({adapter:"reddit",account:"test",action:"create_post",target:{subreddit:"example"},content:{title:"Dry run",body:"Never sent"},owner_command:true});
  assert.equal(prepared.ok,true); assert.equal(prepared.side_effect.performed,false);
  const preview=await service.preview(prepared.draft_id!); assert.equal(preview.state,"PREVIEWED"); assert.equal(fake.publishes,0);
  const pd=(preview.preview as any).digest; const approved=await service.approve(prepared.draft_id!,pd,`APPROVE ${prepared.draft_id}`,"mcp"); assert.equal(approved.ok,true); const token=(approved.result as any).approval_token;
  const published=await service.publish(prepared.draft_id!,token); assert.equal(published.side_effect.performed,true); assert.equal(fake.publishes,1);
  const replay=await service.publish(prepared.draft_id!,token); assert.equal(replay.ok,false); assert.equal(fake.publishes,1); assert.equal(service.store.getDraft(prepared.draft_id!)?.state,"PUBLISHED"); service.store.db.close(); fs.rmSync(stateDir,{recursive:true,force:true});});
test("GPT Action confirmed publish uses exact preview digest and is idempotent",async()=>{const {service,fake,stateDir}=setup();
  const prepared=await service.prepare({adapter:"reddit",account:"test",action:"create_post",target:{subreddit:"example"},content:{title:"Action dry run",body:"Never sent twice"},owner_command:true},"gpt-action");
  const preview=await service.preview(prepared.draft_id!,"gpt-action"); const pd=(preview.preview as any).digest;
  const wrong=await service.publishConfirmedAction(prepared.draft_id!,"sha256:not-the-preview","gpt-action"); assert.equal(wrong.ok,false); assert.equal(fake.publishes,0);
  const published=await service.publishConfirmedAction(prepared.draft_id!,pd,"gpt-action"); assert.equal(published.ok,true); assert.equal(published.side_effect.performed,true); assert.equal((published.result as any).action,"create_post"); assert.equal(fake.publishes,1);
  const replay=await service.publishConfirmedAction(prepared.draft_id!,pd,"gpt-action"); assert.equal(replay.ok,true); assert.equal(replay.side_effect.performed,false); assert.equal((replay.result as any).already_published,true); assert.equal(fake.publishes,1);
  service.store.db.close(); fs.rmSync(stateDir,{recursive:true,force:true});});
test("prepare rejects missing direct-owner marker",async()=>{const {service,stateDir}=setup(); const r=await service.prepare({adapter:"reddit",account:"test",action:"create_post",target:{subreddit:"x"},content:{title:"x"}}); assert.equal(r.ok,false); service.store.db.close(); fs.rmSync(stateDir,{recursive:true,force:true});});
test("default account resolves to shared persistent profile",async()=>{const {service,stateDir}=setup(); const r=await service.prepare({adapter:"reddit",account:"default",action:"create_post",target:{subreddit:"x"},content:{title:"x"},owner_command:true}); assert.equal(r.account,"owner-main"); assert.equal(service.store.getDraft(r.draft_id!)?.account,"owner-main"); service.store.db.close(); fs.rmSync(stateDir,{recursive:true,force:true});});
test("typed adapter error preserves meaning and next action",async()=>{const {service,stateDir}=setup(); class ExistingReview extends FakeReddit { async preview():Promise<never>{throw new PublisherError("REVIEW_ALREADY_EXISTS","A review already exists",{place_name:"Cafe"},[{tool:"publication_prepare",args:{action:"edit"}}]);} } service.register(new ExistingReview()); const p=await service.prepare({adapter:"reddit",account:"test",action:"create_post",target:{subreddit:"x"},content:{title:"x"},owner_command:true}); const r=await service.preview(p.draft_id!); assert.equal(r.error?.code,"REVIEW_ALREADY_EXISTS"); assert.equal((r.error?.details as any).place_name,"Cafe"); assert.equal(r.next_actions[0].tool,"publication_prepare"); service.store.db.close(); fs.rmSync(stateDir,{recursive:true,force:true});});


test("identical Reddit DM retries across new drafts are deduplicated with a persisted transaction intent",async()=>{
  const {service,fake,stateDir}=setup();
  const send=async(body:string,withFullname=true)=>{const target:any={recipient_username:"TopCommenter"}; if(withFullname)target.recipient_fullname="t2_peer"; const prepared=await service.prepare({adapter:"reddit",account:"test",action:"send_chat_message",target,content:{body},owner_command:true},"gpt-action"); const preview=await service.preview(prepared.draft_id!,"gpt-action"); return service.publishConfirmedAction(prepared.draft_id!,(preview.preview as any).digest,"gpt-action");};
  const first=await send("same DM body",true); assert.equal(first.ok,true); assert.equal(first.side_effect.performed,true); assert.equal(fake.publishes,1); assert.equal(fake.executionKeys.length,1);
  const second=await send("same DM body",false); assert.equal(second.ok,true); assert.equal(second.side_effect.performed,false); assert.equal((second.result as any).deduplicated_retry,true); assert.equal((second.result as any).external_id,"$matrix_event_dryrun"); assert.equal(fake.publishes,1);
  const roomPrepared=await service.prepare({adapter:"reddit",account:"test",action:"send_chat_message",target:{room_id:"!peerroom:reddit.com"},content:{body:"same DM body"},owner_command:true},"gpt-action"); const roomPreview=await service.preview(roomPrepared.draft_id!,"gpt-action"); const switched=await service.publishConfirmedAction(roomPrepared.draft_id!,(roomPreview.preview as any).digest,"gpt-action");
  assert.equal(switched.ok,true); assert.equal(switched.side_effect.performed,false); assert.equal((switched.result as any).deduplicated_retry,true); assert.equal(fake.publishes,1);
  const changed=await send("different DM body"); assert.equal(changed.ok,true); assert.equal(changed.side_effect.performed,true); assert.equal(fake.publishes,2); assert.notEqual(fake.executionKeys[0],fake.executionKeys[1]);
  service.store.db.close(); fs.rmSync(stateDir,{recursive:true,force:true});
});

test("unfinished Reddit DM mutation intent survives PublisherService restart",async()=>{
  const {service,stateDir}=setup();
  const fp="f".repeat(64); const first=service.store.acquireMutationIntent({fingerprint:fp,adapter:"reddit",account:"owner-main",action:"send_chat_message",draft_id:"draft-a"});
  service.store.db.close();
  const config:any={stateDir,socketPath:path.join(stateDir,"sock"),chromePath:"/missing/chrome",display:":98",approvalTtlSeconds:900,mutationCooldownSeconds:0,browserIdleSeconds:90,redditMetadataCacheSeconds:900,actionsHost:"127.0.0.1",actionsPort:8791,defaultAccount:"owner-main",browserServicePrefix:"reddit-agent-publisher-browser",cdpUrl:"http://127.0.0.1:9222"};
  const reopened=new PublisherService(config); const second=reopened.store.acquireMutationIntent({fingerprint:fp,adapter:"reddit",account:"owner-main",action:"send_chat_message",draft_id:"draft-b"});
  assert.equal(second.reused,true); assert.equal(second.completed,false); assert.equal(second.transaction_key,first.transaction_key);
  reopened.store.db.close(); fs.rmSync(stateDir,{recursive:true,force:true});
});


test("terminal Reddit DM recipient/identity failures are final while auth/rate/network remain retryable",()=>{
  for(const code of ["PUBLISH_RESULT_AMBIGUOUS","RECIPIENT_NOT_FOUND","RECIPIENT_IDENTITY_MISMATCH","RECIPIENT_SELF","RECIPIENT_CHAT_UNAVAILABLE"]) assert.equal(isFinalPublishFailure(`${code}: example`),true,code);
  for(const code of ["AUTH_REQUIRED","RATE_LIMITED","REDDIT_CHAT_FAILED","SITE_CHANGED"]) assert.equal(isFinalPublishFailure(`${code}: example`),false,code);
});
