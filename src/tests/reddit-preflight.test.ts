import test from "node:test";
import assert from "node:assert/strict";
import { classifyRedditNotification, evaluateRedditEligibility, extractRedditEligibilityRequirements, normalizeRedditSelfProfile, summarizeUnreadRedditNotifications } from "../reddit-preflight.js";

test("Reddit self profile exposes separate comment/post karma and age",()=>{
  const profile=normalizeRedditSelfProfile({name:"owner",comment_karma:12,link_karma:34,total_karma:46,created_utc:1_700_000_000},1_700_000_000_000+90*86_400_000) as any;
  assert.equal(profile.comment_karma,12); assert.equal(profile.post_karma,34); assert.equal(profile.total_karma,46); assert.equal(profile.account_age_days,90);
});

test("eligibility parser distinguishes comment karma from total karma and account age",()=>{
  const requirements=extractRedditEligibilityRequirements("Your account must be at least 2 months old and have 300+ COMMENT karma. Total karma does not count.","community_rule","all");
  const profile={comment_karma:0,post_karma:500,total_karma:500,account_age_days:100};
  const result=evaluateRedditEligibility(profile,requirements,"comment") as any;
  assert.equal(result.blocked,true);
  assert.equal(result.blockers.some((x:any)=>x.kind==="comment_karma" && x.minimum===300 && x.actual===0),true);
  assert.equal(result.blockers.some((x:any)=>x.kind==="account_age_days" && x.minimum===60),false);
});

test("explicit exemption makes a numeric eligibility rule advisory instead of a hard blocker",()=>{
  const requirements=extractRedditEligibilityRequirements("Requests need at least 300 comment karma; OFFER posts are exempt from this requirement.","community_rule","all");
  assert.equal(requirements[0]?.confidence,"advisory");
});

test("AutoModerator removals are important notifications even when not replies",()=>{
  const item=classifyRedditNotification({id:"m1",author:"AutoModerator",subject:"Your post was removed",body:"You need 300 comment karma",unread:true,subreddit:"GiftofGames"}) as any;
  assert.equal(item.notification_type,"moderation"); assert.equal(item.important,true);
  const digest=summarizeUnreadRedditNotifications([item,{id:"m2",author:"alice",subject:"hello",body:"hi",unread:true}],5) as any;
  assert.equal(digest.unread_count,2); assert.equal(digest.important_count,1); assert.equal(digest.items[0].id,"m1");
});


test("ordinary replies mentioning warnings are not misclassified as moderation",()=>{
  const item=classifyRedditNotification({id:"m2",author:"alice",subject:"post reply",body:"They changed direction without any warning",unread:true,subreddit:"Vilnius",was_comment:true}) as any;
  assert.equal(item.notification_type,"reply"); assert.equal(item.important,false);
});

test("generic AutoModerator boilerplate is kept but not promoted as an important removal",()=>{
  const item=classifyRedditNotification({id:"m3",author:"AutoModerator",subject:"post reply",body:"If this post doesn't follow the rules, please report it to the mods.",unread:true,subreddit:"example",was_comment:true}) as any;
  assert.equal(item.notification_type,"moderation"); assert.equal(item.important,false);
});


test("bell removal text becomes high-confidence eligibility evidence",()=>{
  const text="YOUR COMMENT HAS BEEN REMOVED. Reason: You do not meet the subreddit requirements. You need 300+ COMMENT karma and a 2 month old account. Comment karma is NOT post karma or total karma.";
  const requirements=extractRedditEligibilityRequirements(text,"moderation_message","comment");
  const result=evaluateRedditEligibility({comment_karma:0,post_karma:85,total_karma:85,account_age_days:962},requirements,"comment") as any;
  assert.equal(result.blocked,true);
  assert.equal(result.blockers.some((x:any)=>x.kind==="comment_karma" && x.minimum===300),true);
  assert.equal(result.checks.some((x:any)=>x.kind==="account_age_days" && x.minimum===60 && x.met===true),true);
});

test("bell items with unknown read state are still attention candidates without pretending they are unread",()=>{
  const digest=summarizeUnreadRedditNotifications([
    {id:"ann_1",source:"reddit-bell",author:"AutoModerator",subject:"AutoModerator notification",body:"YOUR COMMENT HAS BEEN REMOVED. You need 300 comment karma.",read_state:"unknown",subreddit:"GiftofGames"},
  ],5) as any;
  assert.equal(digest.unread_count,0);
  assert.equal(digest.unknown_read_state_count,1);
  assert.equal(digest.important_count,1);
  assert.equal(digest.items[0].read_state,"unknown");
});


test("attention digest prioritizes the newest important notification",()=>{
  const digest=summarizeUnreadRedditNotifications([
    {id:"old",author:"AutoModerator",subject:"Your post was removed",body:"Need 10 comment karma",unread:true,created_at:"2026-08-01T00:00:00Z",subreddit:"oldsub"},
    {id:"new",source:"reddit-bell",author:"AutoModerator",subject:"AutoModerator notification",body:"YOUR COMMENT HAS BEEN REMOVED. Need 300 comment karma",read_state:"unknown",created_at:"2026-09-07T16:47:45Z",subreddit:"GiftofGames"},
  ],5) as any;
  assert.equal(digest.items[0].id,"new");
});
