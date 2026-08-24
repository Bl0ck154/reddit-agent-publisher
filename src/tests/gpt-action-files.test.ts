import assert from "node:assert/strict";
import test from "node:test";
import { ActionFileError, detectActionImage, validateGptActionFileUrl } from "../gpt-action-files.js";

test("GPT Action files allow only HTTPS oaiusercontent conversation files",()=>{
  assert.equal(validateGptActionFileUrl("https://files.oaiusercontent.com/signed-value").hostname,"files.oaiusercontent.com");
  for(const value of ["http://files.oaiusercontent.com/x","https://127.0.0.1/x","https://oaiusercontent.com.evil.invalid/x","https://user:pass@files.oaiusercontent.com/x"]){
    assert.throws(()=>validateGptActionFileUrl(value),ActionFileError);
  }
});

test("GPT Action image detection uses payload signatures",()=>{
  assert.equal(detectActionImage(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])).mime_type,"image/png");
  assert.equal(detectActionImage(Buffer.from([0xff,0xd8,0xff,0x00])).mime_type,"image/jpeg");
  assert.throws(()=>detectActionImage(Buffer.from("not an image")),ActionFileError);
});
