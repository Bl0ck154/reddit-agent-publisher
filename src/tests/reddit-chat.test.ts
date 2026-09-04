import assert from "node:assert/strict";
import test from "node:test";
import { extractRedditChatToken, isRedditChatRoomId, normalizeRedditChatMessages, normalizeRedditChatSync } from "../reddit-chat.js";

test("Reddit Chat bootstrap token is extracted without persisting credentials",()=>{
  const parsed=extractRedditChatToken('<html><rs-app token="{&quot;token&quot;:&quot;abc.def.sig&quot;,&quot;expires&quot;:1770000000000}"></rs-app></html>');
  assert.equal(parsed.token,"abc.def.sig");
  assert.equal(parsed.expiresAt,1770000000000);
  assert.throws(()=>extractRedditChatToken("<html></html>"),/SITE_CHANGED/);
});

test("Reddit Chat room ids are bound to reddit.com Matrix rooms",()=>{
  assert.equal(isRedditChatRoomId("!room123:reddit.com"),true);
  assert.equal(isRedditChatRoomId("!room123:evil.invalid"),false);
});

test("Reddit Chat sync exposes DM participants, unread count and latest message",()=>{
  const sync={
    account_data:{events:[{type:"m.direct",content:{"@t2_peer:reddit.com":["!room123:reddit.com"]}}]},
    rooms:{join:{"!room123:reddit.com":{
      state:{events:[{type:"m.room.member",state_key:"@t2_peer:reddit.com",content:{displayname:"OtherUser"}}]},
      timeline:{events:[{type:"m.room.message",event_id:"$one",sender:"@t2_peer:reddit.com",origin_server_ts:1770000000000,content:{msgtype:"m.text",body:"hello"}}]},
      unread_notifications:{notification_count:2}
    }}}
  };
  const all=normalizeRedditChatSync(sync,"@me:reddit.com",false,25) as any;
  assert.equal(all.count,1);
  assert.equal(all.conversations[0].room_id,"!room123:reddit.com");
  assert.equal(all.conversations[0].participants[0].username,"OtherUser");
  assert.equal(all.conversations[0].unread_count,2);
  assert.equal(all.conversations[0].latest_message.body,"hello");
  const unread=normalizeRedditChatSync({...sync,rooms:{join:{"!room123:reddit.com":{...sync.rooms.join["!room123:reddit.com"],unread_notifications:{notification_count:0}}}}},"@me:reddit.com",true,25) as any;
  assert.equal(unread.count,0);
});

test("Reddit Chat room history is chronological and marks own messages",()=>{
  const payload={state:[{type:"m.room.member",state_key:"@t2_peer:reddit.com",content:{displayname:"OtherUser"}}],chunk:[
    {type:"m.room.message",event_id:"$new",sender:"@me:reddit.com",origin_server_ts:2000,content:{msgtype:"m.text",body:"reply"}},
    {type:"m.room.message",event_id:"$old",sender:"@t2_peer:reddit.com",origin_server_ts:1000,content:{msgtype:"m.text",body:"hello"}}
  ]};
  const messages=normalizeRedditChatMessages(payload,"@me:reddit.com") as any[];
  assert.deepEqual(messages.map(x=>x.body),["hello","reply"]);
  assert.equal(messages[0].from_me,false);
  assert.equal(messages[1].from_me,true);
});
