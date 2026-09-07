type JsonObject = Record<string, unknown>;

export type RedditEligibilityScope = "post" | "comment" | "all";
export type RedditEligibilityKind = "comment_karma" | "post_karma" | "total_karma" | "account_age_days";
export type RedditEligibilityRequirement = {
  kind: RedditEligibilityKind;
  minimum: number;
  scope: RedditEligibilityScope;
  source: "community_rule" | "community_description" | "moderation_message";
  evidence: string;
  confidence: "high" | "advisory";
};

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}
function number(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function compact(value: string, max = 260): string {
  const text=value.replace(/\s+/g," ").trim();
  return text.length>max ? `${text.slice(0,max-1)}…` : text;
}

export function normalizeRedditSelfProfile(payload: unknown, nowMs = Date.now()): JsonObject {
  const root=object(payload) ?? {};
  const data=object(root.data) ?? root;
  const createdUtc=number(data.created_utc);
  const postKarma=number(data.link_karma);
  const commentKarma=number(data.comment_karma);
  const totalKarma=number(data.total_karma) ?? (postKarma !== undefined && commentKarma !== undefined ? postKarma + commentKarma : undefined);
  const ageDays=createdUtc === undefined ? undefined : Math.max(0,Math.floor((nowMs-createdUtc*1000)/86_400_000));
  return {
    username:string(data.name),
    fullname:string(data.id),
    comment_karma:commentKarma,
    post_karma:postKarma,
    total_karma:totalKarma,
    created_at:createdUtc === undefined ? undefined : new Date(createdUtc*1000).toISOString(),
    account_age_days:ageDays,
  };
}

function minimumNumber(raw: string): number | undefined {
  const n=Number(raw.replace(/,/g,""));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
function evidenceWindow(text: string, index: number, length: number): string {
  return compact(text.slice(Math.max(0,index-120),Math.min(text.length,index+length+120)));
}
function confidenceForEvidence(evidence: string): "high" | "advisory" {
  return /\b(?:exempt|except|unless|does not apply|don't need|do not need|not required)\b/i.test(evidence) ? "advisory" : "high";
}
function addRequirement(out: RedditEligibilityRequirement[], req: RedditEligibilityRequirement): void {
  if (!Number.isFinite(req.minimum)) return;
  if (out.some(item=>item.kind===req.kind && item.minimum===req.minimum && item.scope===req.scope && item.source===req.source)) return;
  out.push(req);
}

export function extractRedditEligibilityRequirements(
  rawText: string,
  source: RedditEligibilityRequirement["source"],
  scope: RedditEligibilityScope = "all",
): RedditEligibilityRequirement[] {
  const text=String(rawText ?? "").replace(/\r/g,"");
  const out: RedditEligibilityRequirement[]=[];
  const karmaSpecs: Array<{kind:RedditEligibilityKind;label:string}> = [
    {kind:"comment_karma",label:"comment(?:s)?\\s*[- ]?karma"},
    {kind:"post_karma",label:"(?:post|link)\\s*[- ]?karma"},
    {kind:"total_karma",label:"(?:total|combined)\\s*[- ]?karma"},
  ];
  for (const spec of karmaSpecs) {
    const patterns=[
      new RegExp(`\\b(\\d[\\d,]*)\\s*\\+?\\s*${spec.label}\\b`,"gi"),
      new RegExp(`\\b${spec.label}\\s*(?:of|:|>=|>|at\\s+least|minimum(?:\\s+of)?|min(?:imum)?(?:\\s+of)?)?\\s*(\\d[\\d,]*)\\+?`,"gi"),
    ];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const min=minimumNumber(match[1]); if(min===undefined) continue;
        const evidence=evidenceWindow(text,match.index ?? 0,match[0].length);
        addRequirement(out,{kind:spec.kind,minimum:min,scope,source,evidence,confidence:confidenceForEvidence(evidence)});
      }
    }
  }
  const agePatterns=[
    /\baccount(?:s)?[\s\S]{0,45}?(?:at\s+least|minimum(?:\s+of)?|must(?:\s+be)?|need(?:s)?\s+to\s+be|older\s+than)\s*(\d{1,4})\s*(days?|weeks?|months?|years?)\s*(?:old)?\b/gi,
    /\b(?:at\s+least|minimum(?:\s+of)?|older\s+than)\s*(\d{1,4})\s*(days?|weeks?|months?|years?)\s+old\b/gi,
    /\b(?:an?\s+)?(\d{1,4})\s*(days?|weeks?|months?|years?)\s+old\s+account\b/gi,
  ];
  for (const pattern of agePatterns) {
    for (const match of text.matchAll(pattern)) {
      const value=Number(match[1]); const unit=match[2].toLowerCase();
      if(!Number.isFinite(value)) continue;
      const days=Math.ceil(value*(unit.startsWith("day")?1:unit.startsWith("week")?7:unit.startsWith("month")?30:365));
      const evidence=evidenceWindow(text,match.index ?? 0,match[0].length);
      addRequirement(out,{kind:"account_age_days",minimum:days,scope,source,evidence,confidence:confidenceForEvidence(evidence)});
    }
  }
  return out;
}

function actualFor(profile: JsonObject, kind: RedditEligibilityKind): number | undefined {
  if(kind==="comment_karma") return number(profile.comment_karma);
  if(kind==="post_karma") return number(profile.post_karma);
  if(kind==="total_karma") return number(profile.total_karma);
  return number(profile.account_age_days);
}

export function evaluateRedditEligibility(profile: JsonObject, requirements: RedditEligibilityRequirement[], action: "post"|"comment"): JsonObject {
  const applicable=requirements.filter(req=>req.scope==="all" || req.scope===action);
  const checks=applicable.map(req=>{
    const actual=actualFor(profile,req.kind);
    return {...req,actual,met:actual===undefined?undefined:actual>=req.minimum};
  });
  const blockers=checks.filter((check:any)=>check.confidence==="high" && check.met===false);
  const unknown=checks.filter((check:any)=>check.actual===undefined);
  return {
    status:blockers.length?"blocked":applicable.length && !unknown.length?"eligible":"unknown",
    blocked:Boolean(blockers.length),
    blockers,
    checks,
    detected_requirements:applicable.length,
  };
}

export function classifyRedditNotification(item: JsonObject): JsonObject {
  const author=String(item.author ?? "");
  const subject=String(item.subject ?? "");
  const body=String(item.body ?? "");
  const distinguished=String(item.distinguished ?? "");
  const combined=`${subject}\n${body}`;
  const automod=/^AutoModerator$/i.test(author);
  const moderator=/^(?:moderator|admin)$/i.test(distinguished);
  const strongModerationSignal=/\b(?:your|this)\s+(?:post|comment|submission)[\s\S]{0,90}\b(?:removed|deleted|filtered|locked)\b|\b(?:removed|deleted|filtered)\s+(?:your|this)\s+(?:post|comment|submission)\b|\b(?:automatically|auto)[- ]?(?:removed|filtered)\b|\b(?:you|your account)\s+(?:must|need|needs|required|requires|has to have)[\s\S]{0,70}\b(?:karma|account age)\b|\b(?:banned|ban notice|rule violation|not eligible)\b/i.test(combined);
  const subjectModeration=/\b(?:post|comment|submission)\s+(?:removed|deleted|filtered)\b|\b(?:moderator|modmail|ban notice|rule violation)\b/i.test(subject);
  const moderation=automod || moderator || subjectModeration || strongModerationSignal;
  const important=moderator || subjectModeration || strongModerationSignal;
  const reply=Boolean(item.was_comment) || /\b(?:reply|mention)\b/i.test(subject);
  const notification_type=moderation?"moderation":reply?"reply":"message";
  let subreddit=string(item.subreddit);
  if(!subreddit){
    const context=String(item.context ?? "");
    const m=context.match(/\/r\/([A-Za-z0-9_]{2,21})(?:\/|$)/i) ?? combined.match(/\br\/([A-Za-z0-9_]{2,21})\b/i);
    subreddit=m?.[1];
  }
  return {...item,subreddit,notification_type,important,summary:compact([subject,body].filter(Boolean).join(": "),320)};
}

export function summarizeUnreadRedditNotifications(items: JsonObject[], limit=5): JsonObject {
  const classified=items.map(classifyRedditNotification);
  const unread=classified.filter(item=>item.unread===true);
  const unknownRead=classified.filter(item=>item.unread===undefined && String(item.read_state ?? "")==="unknown");
  const attention=[...unread,...unknownRead].sort((a,b)=>{
    const bt=Date.parse(String(b.created_at ?? "")); const at=Date.parse(String(a.created_at ?? ""));
    return (Number.isFinite(bt)?bt:0)-(Number.isFinite(at)?at:0);
  });
  const important=attention.filter(item=>Boolean(item.important));
  const ordinary=attention.filter(item=>!item.important);
  const selected=[...important,...ordinary].slice(0,Math.max(1,limit)).map(item=>({
    id:item.id,announcement_id:item.announcement_id,source:item.source,notification_type:item.notification_type,subreddit:item.subreddit,author:item.author,subject:item.subject,summary:item.summary,body:item.body,created_at:item.created_at,context:item.context,target_url:item.target_url,notification_url:item.notification_url,unread:item.unread,read_state:item.read_state,important:item.important,
  }));
  return {unread_count:unread.length,unknown_read_state_count:unknownRead.length,important_count:important.length,items:selected};
}
