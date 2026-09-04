import assert from "node:assert/strict";
import test from "node:test";
import { extractRedditChatToken, findDirectRoomForPeer, isRedditChatRoomId, normalizeRedditChatMessages, normalizeRedditChatSync, normalizeRedditRecipientProfile, redditDirectRoomCreateBody, redditMatrixUserIdFromFullname } from "../reddit-chat.js";

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


test("Reddit comment author fullname maps deterministically to Matrix user id",()=>{
  assert.equal(redditMatrixUserIdFromFullname("t2_AbC123"),"@t2_abc123:reddit.com");
  assert.throws(()=>redditMatrixUserIdFromFullname("u/example"),/t2_/);
  const profile=normalizeRedditRecipientProfile({kind:"t2",data:{id:"AbC123",name:"TopCommenter",is_suspended:false}},"topcommenter") as any;
  assert.equal(profile.username,"TopCommenter");
  assert.equal(profile.fullname,"t2_abc123");
  assert.equal(profile.matrix_user_id,"@t2_abc123:reddit.com");
  assert.throws(()=>normalizeRedditRecipientProfile({data:{id:"abc123",name:"SomeoneElse"}},"TopCommenter"),/IDENTITY_MISMATCH/);
});

test("new Reddit direct rooms carry native direct-chat state",()=>{
  const body=redditDirectRoomCreateBody("@t2_me:reddit.com","@t2_peer:reddit.com") as any;
  assert.equal(body.is_direct,true);
  assert.deepEqual(body.invite,["@t2_peer:reddit.com"]);
  assert.equal(body.initial_state[0].type,"com.reddit.chat.type");
  assert.equal(body.initial_state[0].content.type,"direct");
  assert.deepEqual(body.initial_state[0].content.participants,["@t2_me:reddit.com","@t2_peer:reddit.com"]);
});

test("existing direct room is found by m.direct or one-to-one membership",()=>{
  const direct={account_data:{events:[{type:"m.direct",content:{"@t2_peer:reddit.com":["!direct:reddit.com"]}}]},rooms:{join:{"!direct:reddit.com":{state:{events:[]},timeline:{events:[]}}}}};
  assert.equal(findDirectRoomForPeer(direct,"@t2_me:reddit.com","@t2_peer:reddit.com"),"!direct:reddit.com");
  const fallback={rooms:{join:{"!fallback:reddit.com":{state:{events:[
    {type:"m.room.member",state_key:"@t2_me:reddit.com",content:{membership:"join"}},
    {type:"m.room.member",state_key:"@t2_peer:reddit.com",content:{membership:"invite"}},
  ]},timeline:{events:[]}}}}};
  assert.equal(findDirectRoomForPeer(fallback,"@t2_me:reddit.com","@t2_peer:reddit.com"),"!fallback:reddit.com");
});
