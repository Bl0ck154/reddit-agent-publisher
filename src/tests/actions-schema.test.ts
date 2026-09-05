import assert from "node:assert/strict";
import test from "node:test";
import { buildActionsOpenApi } from "../actions-schema.js";

test("GPT Actions schema uses the deployed HTTPS origin and Bearer auth",()=>{
  const schema=buildActionsOpenApi("https://publisher.example.com/") as any;
  assert.equal(schema.openapi,"3.1.0");
  assert.equal(schema.info.version,"1.2.0");
  assert.equal(schema.jsonSchemaDialect,"https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.servers[0].url,"https://publisher.example.com");
  assert.equal(schema.components.securitySchemes.bearerAuth.scheme,"bearer");
  const files=schema.paths["/v1/reddit/posts/preview"].post.requestBody.content["application/json"].schema.properties.openaiFileIdRefs;
  assert.equal(files.maxItems,4);
  assert.equal(files.items.type,"string");
});

test("read and preview actions are non-consequential but real publish always requires confirmation",()=>{
  const schema=buildActionsOpenApi("https://publisher.example.com") as any;
  const operations=Object.values(schema.paths).flatMap((path:any)=>Object.values(path));
  assert.equal(operations.every((operation:any)=>typeof operation["x-openai-isConsequential"]==="boolean"),true);
  assert.equal(schema.paths["/v1/status"].get["x-openai-isConsequential"],false);
  assert.equal(schema.paths["/v1/reddit/rules"].get["x-openai-isConsequential"],false);
  assert.equal(schema.paths["/v1/reddit/flairs"].get["x-openai-isConsequential"],false);
  assert.equal(schema.paths["/v1/reddit/thread"].get["x-openai-isConsequential"],false);
  const threadSort=schema.paths["/v1/reddit/thread"].get.parameters.find((p:any)=>p.name==="sort");
  assert.deepEqual(threadSort.schema.enum,["best","top","new","old","controversial","qa"]);
  assert.equal(schema.paths["/v1/reddit/activity"].get["x-openai-isConsequential"],false);
  assert.equal(schema.paths["/v1/reddit/inbox"].get["x-openai-isConsequential"],false);
  assert.equal(schema.paths["/v1/reddit/notifications"].get["x-openai-isConsequential"],false);
  assert.equal(schema.paths["/v1/reddit/chats"].get["x-openai-isConsequential"],false);
  assert.equal(schema.paths["/v1/reddit/chats/messages"].get["x-openai-isConsequential"],false);
  assert.equal(schema.paths["/v1/reddit/chats/attachment"].get["x-openai-isConsequential"],false);
  assert.equal(schema.paths["/v1/reddit/chats/replies/preview"].post["x-openai-isConsequential"],false);
  assert.equal(schema.paths["/v1/reddit/chats/replies/publish"].post["x-openai-isConsequential"],true);
  assert.equal(schema.paths["/v1/reddit/chats/direct/preview"].post["x-openai-isConsequential"],false);
  assert.equal(schema.paths["/v1/reddit/chats/direct/publish"].post["x-openai-isConsequential"],true);
  assert.equal(schema.paths["/v1/reddit/posts/preview"].post["x-openai-isConsequential"],false);
  assert.equal(schema.paths["/v1/reddit/posts/publish"].post["x-openai-isConsequential"],true);
  assert.equal(schema.paths["/v1/reddit/comments/publish"].post["x-openai-isConsequential"],true);
  assert.equal(schema.paths["/v1/reddit/edits/publish"].post["x-openai-isConsequential"],true);
  const redditBodyFormat=schema.paths["/v1/reddit/posts/publish"].post.requestBody.content["application/json"].schema.properties.body_format;
  assert.deepEqual(redditBodyFormat.enum,["auto","plain","markdown"]);
  assert.equal(redditBodyFormat.default,"auto");
  assert.equal(schema.paths["/v1/publications/{draft_id}/publish"].post["x-openai-isConsequential"],true);
  assert.equal("requires_confirmation" in schema.components.schemas.PreviewResult.properties,false);
  assert.equal(Object.keys(schema.paths).some((path:string)=>path.includes("google")),false);
});

test("schema exposes no login, password, approval-token or arbitrary RPC endpoint",()=>{
  const schema=buildActionsOpenApi("https://publisher.example.com") as any;
  const paths=Object.keys(schema.paths);
  assert.equal(paths.some((p:string)=>/login|rpc|token|approve/i.test(p)),false);
  assert.ok(paths.includes("/v1/publications/{draft_id}/publish"));
});


test("Reddit publish authorization persists across retry follow-ups",()=>{
  const schema=buildActionsOpenApi("https://publisher.example.com") as any;
  const commentPublish=String(schema.paths["/v1/reddit/comments/publish"].post.description);
  const chatPublish=String(schema.paths["/v1/reddit/chats/replies/publish"].post.description);
  const directPublish=String(schema.paths["/v1/reddit/chats/direct/publish"].post.description);
  const commentPreview=String(schema.paths["/v1/reddit/comments/preview"].post.description);
  const legacyPublish=String(schema.paths["/v1/publications/{draft_id}/publish"].post.description);
  assert.match(commentPublish,/earlier or current turn/i);
  assert.match(commentPublish,/persists/i);
  assert.match(commentPublish,/retry\/status follow-ups/i);
  assert.match(commentPreview,/authorization remains valid/i);
  assert.match(chatPublish,/authorization persists/i);
  assert.match(chatPublish,/room_id/i);
  assert.match(directPublish,/recipient_fullname/i);
  assert.match(directPublish,/message request/i);
  assert.match(commentPreview,/without another chat confirmation/i);
  assert.match(legacyPublish,/latest user message is only a retry\/status acknowledgement/i);
  assert.equal(schema.components.schemas.PreviewResult.properties.next_step_if_already_authorized.enum[0],"publishPublication");
  assert.match(String(schema.components.schemas.PreviewResult.properties.authorization_policy.description),/persists across transient failures/i);
});


test("Reddit Chat schema exposes exact attachment download and one-file sends",()=>{
  const schema=buildActionsOpenApi("https://publisher.example.com") as any;
  const attachment=schema.paths["/v1/reddit/chats/attachment"].get;
  assert.equal(attachment.operationId,"getRedditChatAttachment"); assert.equal(attachment["x-openai-isConsequential"],false);
  assert.match(String(attachment.description),/openaiFileResponse/i); assert.equal(schema.components.schemas.ActionResult.properties.openaiFileResponse.items.format,"uri");
  assert.deepEqual(attachment.parameters.filter((p:any)=>p.required).map((p:any)=>p.name),["room_id","event_id"]);
  const reply=schema.paths["/v1/reddit/chats/replies/publish"].post.requestBody.content["application/json"].schema;
  assert.deepEqual(reply.required,["room_id"]); assert.equal(reply.properties.openaiFileIdRefs.maxItems,1); assert.equal(reply.properties.body.type,"string");
  const direct=schema.paths["/v1/reddit/chats/direct/publish"].post.requestBody.content["application/json"].schema;
  assert.deepEqual(direct.required,["recipient_username"]); assert.equal(direct.properties.openaiFileIdRefs.maxItems,1);
  assert.match(String(schema.paths["/v1/reddit/chats/messages"].get.description),/attachment metadata/i);
});
