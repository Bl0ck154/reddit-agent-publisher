import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExternalRedditObscura } from "../external-reddit-obscura.js";
import type { Config } from "../config.js";

test("Lightpanda recreates a closed CDP context before reusing pages", async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"lp-context-unit-"));
  try {
    const client=new ExternalRedditObscura({stateDir:root} as Config,"lightpanda") as any;
    const target=client.target("owner-main");
    const session=client.session(target.instance);
    const page={isClosed:()=>false};
    const oldContext={isClosed:()=>true,pages:()=>[]};
    const nextContext={isClosed:()=>false,pages:()=>[],newPage:async()=>page};
    let contextCreates=0;
    const browser={contexts:()=>[oldContext],newContext:async()=>{contextCreates++;return nextContext;}};
    session.context=oldContext;
    session.authImported=true;
    client.browser=async()=>browser;
    client.restoreAuth=async(_target:unknown,_session:unknown,ctx:unknown)=>{ assert.equal(ctx,nextContext); };
    const result=await client.page("owner-main");
    assert.equal(result,page);
    assert.equal(contextCreates,1);
    assert.equal(session.context,nextContext);
    assert.equal(session.authImported,false);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
