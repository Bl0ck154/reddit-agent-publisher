import assert from "node:assert/strict";
import test from "node:test";
import { buildActionsOpenApi } from "../actions-schema.js";

test("GPT Actions schema uses the deployed HTTPS origin and Bearer auth",()=>{
  const schema=buildActionsOpenApi("https://publisher.example.com/") as any;
  assert.equal(schema.openapi,"3.1.0");
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
  assert.equal(schema.paths["/v1/reddit/activity"].get["x-openai-isConsequential"],false);
  assert.equal(schema.paths["/v1/reddit/inbox"].get["x-openai-isConsequential"],false);
  assert.equal(schema.paths["/v1/reddit/posts/preview"].post["x-openai-isConsequential"],false);
  assert.equal(schema.paths["/v1/reddit/posts/publish"].post["x-openai-isConsequential"],true);
  assert.equal(schema.paths["/v1/reddit/comments/publish"].post["x-openai-isConsequential"],true);
  assert.equal(schema.paths["/v1/reddit/edits/publish"].post["x-openai-isConsequential"],true);
  const redditBodyFormat=schema.paths["/v1/reddit/posts/publish"].post.requestBody.content["application/json"].schema.properties.body_format;
  assert.deepEqual(redditBodyFormat.enum,["plain","markdown"]);
  assert.equal(redditBodyFormat.default,"plain");
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
