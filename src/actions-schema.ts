export function buildActionsOpenApi(baseUrl: string): Record<string, unknown> {
  const server = baseUrl.replace(/\/$/, "");
  const account = { type: "string", default: "default", description: "Internal Publisher browser-profile id, NOT the Reddit username. Usually omit this field or leave it as default. Use another value only when the owner explicitly selected a configured Publisher profile returned by status." };
  const bodyFormat = { type: "string", enum: ["auto", "plain", "markdown"], default: "auto", description: "Usually leave as auto. Auto is deliberately conservative: it detects only high-confidence unescaped Markdown such as boundary-safe **bold**, *italic*, ~~strike~~, Markdown links, fenced code, or spoilers. It does not infer Markdown from __dunder__, # lines, > lines, or - lines. Use markdown explicitly for headings, lists, quotes, inline code, or any requested formatting. If plain is supplied together with high-confidence Markdown markers, the publisher stops with a format conflict instead of guessing or changing formatting; escape the markers when literal characters are intended." };
  const okResponse = {
    description: "Action result",
    content: { "application/json": { schema: { $ref: "#/components/schemas/ActionResult" } } },
  };
  const previewResponse = {
    description: "A live preview was prepared. Nothing has been published yet.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/PreviewResult" } } },
  };
  const jsonBody = (schema: Record<string, unknown>) => ({ required: true, content: { "application/json": { schema } } });

  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "Reddit Agent Publisher Actions",
      version: "0.2.0",
      description: "Owner-only GPT Actions gateway for Reddit Agent Publisher. Reddit context operations are read-only. Preview operations never submit content. Finalized Reddit posts/comments can use one-step consequential publish actions; legacy publishPublication publishes an existing exact preview.",
    },
    servers: [{ url: server }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/v1/status": {
        get: {
          operationId: "getPublisherStatus",
          "x-openai-isConsequential": false,
          summary: "Check Reddit browser session status",
          description: "Read-only. Use when a publish or Reddit context operation reports that a manual login is required.",
          parameters: [
            { name: "adapter", in: "query", required: false, schema: { type: "string", enum: ["reddit"] } },
            { name: "account", in: "query", required: false, schema: account },
          ],
          responses: { "200": okResponse },
        },
      },
      "/v1/reddit/rules": {
        get: {
          operationId: "getRedditRules",
          "x-openai-isConsequential": false,
          summary: "Read subreddit rules",
          description: "Read-only. Results are cached briefly by the publisher.",
          parameters: [
            { name: "subreddit", in: "query", required: true, schema: { type: "string" } },
            { name: "account", in: "query", required: false, schema: account },
          ],
          responses: { "200": okResponse },
        },
      },
      "/v1/reddit/flairs": {
        get: {
          operationId: "getRedditFlairs",
          "x-openai-isConsequential": false,
          summary: "Read available Reddit post flairs",
          description: "Read-only. Results are cached briefly by the publisher.",
          parameters: [
            { name: "subreddit", in: "query", required: true, schema: { type: "string" } },
            { name: "account", in: "query", required: false, schema: account },
          ],
          responses: { "200": okResponse },
        },
      },
      "/v1/reddit/thread": {
        get: {
          operationId: "getRedditThread",
          "x-openai-isConsequential": false,
          summary: "Read a Reddit post and its comment context",
          description: "Read-only. Use an exact Reddit post or comment permalink. Returns the post, nested comments, the targeted comment when applicable, plus deterministic top_comment/newest_comment/oldest_comment shortcuts for top-level comments. top_comment means the highest Reddit score among returned top-level comments. Comment shortcuts include author and author_fullname (t2_ user id) so an agent can safely address the exact author in a direct-message action.",
          parameters: [
            { name: "url", in: "query", required: true, schema: { type: "string", format: "uri" } },
            { name: "account", in: "query", required: false, schema: account },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
            { name: "depth", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 10, default: 6 } },
            { name: "context", in: "query", required: false, schema: { type: "integer", minimum: 0, maximum: 10, default: 8 } },
          ],
          responses: { "200": okResponse },
        },
      },
      "/v1/reddit/activity": {
        get: {
          operationId: "getMyRedditActivity",
          "x-openai-isConsequential": false,
          summary: "Read the owner's recent Reddit posts and comments",
          description: "Read-only. Useful for locating a recent owner post/comment before reading its thread or preparing a reply.",
          parameters: [
            { name: "account", in: "query", required: false, schema: account },
            { name: "kind", in: "query", required: false, schema: { type: "string", enum: ["all", "posts", "comments"], default: "all" } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } },
          ],
          responses: { "200": okResponse },
        },
      },
      "/v1/reddit/inbox": {
        get: {
          operationId: "getRedditInbox",
          "x-openai-isConsequential": false,
          summary: "Read the owner's Reddit inbox and replies",
          description: "Read-only. Defaults to unread replies/messages so the agent can find new responses before preparing a reply.",
          parameters: [
            { name: "account", in: "query", required: false, schema: account },
            { name: "unread_only", in: "query", required: false, schema: { type: "boolean", default: true } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } },
          ],
          responses: { "200": okResponse },
        },
      },
      "/v1/reddit/notifications": {
        get: { operationId:"getRedditNotifications", "x-openai-isConsequential":false, summary:"Read Reddit reply and mention notifications", description:"Read-only. Returns reply and mention notifications without opening Reddit's bell page, so this does not intentionally mark bell notifications as read. Bell-only engagement events such as vote milestones are intentionally excluded.", parameters:[{name:"account",in:"query",required:false,schema:account},{name:"unread_only",in:"query",required:false,schema:{type:"boolean",default:true}},{name:"limit",in:"query",required:false,schema:{type:"integer",minimum:1,maximum:100,default:25}}], responses:{"200":okResponse} },
      },
      "/v1/reddit/chats": {
        get: { operationId:"getRedditChats", "x-openai-isConsequential":false, summary:"Read current Reddit Chat conversations and DMs", description:"Read-only. Lists current Reddit Chat conversations through the authenticated Reddit session. Use the returned exact room_id for reading or replying; never invent one from a username.", parameters:[{name:"account",in:"query",required:false,schema:account},{name:"unread_only",in:"query",required:false,schema:{type:"boolean",default:false}},{name:"limit",in:"query",required:false,schema:{type:"integer",minimum:1,maximum:100,default:25}}], responses:{"200":okResponse} },
      },
      "/v1/reddit/chats/messages": {
        get: { operationId:"getRedditChatMessages", "x-openai-isConsequential":false, summary:"Read one exact Reddit Chat conversation", description:"Read-only. Loads recent messages from one exact room_id returned by getRedditChats.", parameters:[{name:"room_id",in:"query",required:true,schema:{type:"string"}},{name:"account",in:"query",required:false,schema:account},{name:"limit",in:"query",required:false,schema:{type:"integer",minimum:1,maximum:100,default:50}}], responses:{"200":okResponse} },
      },
      "/v1/reddit/posts/publish": {
        post: {
          operationId: "publishRedditPost",
          "x-openai-isConsequential": true,
          summary: "Publish a finalized Reddit post in one step",
          description: "CONSEQUENTIAL. Use when the user has explicitly asked to publish/post this finalized content in any still-relevant earlier or current turn. That authorization persists for this exact unchanged content/target across transient failures, unavailable tools, authentication recovery, and retry/status follow-ups. Do not ask for an additional chat confirmation before calling this action; ChatGPT's action-approval UI handles any required approval.",
          requestBody: jsonBody({
            type: "object", required: ["subreddit", "title"], additionalProperties: false,
            properties: {
              subreddit: { type: "string", description: "Subreddit name without r/." },
              title: { type: "string" }, body: { type: "string" }, body_format: bodyFormat, url: { type: "string", format: "uri" },
              flair: { type: "string", description: "Visible flair label, if required." }, account,
              openaiFileIdRefs: {
                type: "array", minItems: 1, maxItems: 4, items: { type: "string" },
                description: "Images uploaded or generated in the current ChatGPT conversation. Attach 1–4 image files. ChatGPT replaces these references with short-lived download objects at runtime. Do not combine with url.",
              },
            },
          }),
          responses: { "200": { description: "Published or a structured error", content: { "application/json": { schema: { $ref: "#/components/schemas/PublishResult" } } } } },
        },
      },
      "/v1/reddit/comments/publish": {
        post: {
          operationId: "publishRedditComment",
          "x-openai-isConsequential": true,
          summary: "Publish a finalized Reddit comment in one step",
          description: "CONSEQUENTIAL. Use when the user has explicitly asked to post this finalized comment/reply to this exact Reddit target in any still-relevant earlier or current turn. That authorization persists for the exact unchanged reply/target across transient failures, unavailable tools, authentication recovery, and retry/status follow-ups. Do not ask for an additional chat confirmation before calling this action.",
          requestBody: jsonBody({
            type: "object", required: ["url", "body"], additionalProperties: false,
            properties: { url: { type: "string", format: "uri" }, body: { type: "string" }, body_format: bodyFormat, account },
          }),
          responses: { "200": { description: "Published or a structured error", content: { "application/json": { schema: { $ref: "#/components/schemas/PublishResult" } } } } },
        },
      },
      "/v1/reddit/chats/replies/publish": {
        post: { operationId:"publishRedditChatReply", "x-openai-isConsequential":true, summary:"Send a finalized reply in Reddit Chat", description:"CONSEQUENTIAL. Sends finalized text to one exact Reddit Chat room_id returned by getRedditChats. Use when the user explicitly asked to send this exact reply to that exact chat. Authorization persists for unchanged text/room across transient failures, authentication recovery, and retry/status follow-ups. Never invent room_id or ask an extra confirmation when already authorized.", requestBody:jsonBody({type:"object",required:["room_id","body"],additionalProperties:false,properties:{room_id:{type:"string",description:"Exact room_id returned by getRedditChats."},body:{type:"string"},account}}), responses:{"200":{description:"Sent or a structured error",content:{"application/json":{schema:{$ref:"#/components/schemas/PublishResult"}}}}} },
      },
      "/v1/reddit/chats/direct/publish": {
        post: { operationId:"publishRedditDirectMessage", "x-openai-isConsequential":true, summary:"Send a finalized direct message to a Reddit user", description:"CONSEQUENTIAL. Verifies recipient_username against Reddit immediately before sending. If recipient_fullname (t2_...) came from getRedditThread, pass it too; the server rejects any username/account-id mismatch. Reuses an existing 1:1 Chat when present, otherwise creates a native Reddit direct Chat/message request with com.reddit.chat.type state and sends the text. Preview creates no chat.", requestBody:jsonBody({type:"object",required:["recipient_username","body"],additionalProperties:false,properties:{recipient_username:{type:"string",description:"Exact Reddit username, for example top_comment.author."},recipient_fullname:{type:"string",description:"Optional but strongly preferred t2_ account id, for example top_comment.author_fullname."},body:{type:"string"},account}}), responses:{"200":{description:"Sent or a structured error",content:{"application/json":{schema:{$ref:"#/components/schemas/PublishResult"}}}}} },
      },
      "/v1/reddit/edits/publish": {
        post: {
          operationId: "publishRedditEdit",
          "x-openai-isConsequential": true,
          summary: "Edit the owner's Reddit post or comment in one step",
          description: "CONSEQUENTIAL. Use when the user has finalized replacement body text for an exact owned Reddit post/comment and explicitly authorized saving it in any still-relevant earlier or current turn. That authorization persists for the exact unchanged edit/target across transient failures and retry/status follow-ups. Reddit post titles cannot be edited; this changes only the body/comment text. The server verifies ownership from the live Reddit UI before saving.",
          requestBody: jsonBody({
            type: "object", required: ["url", "body"], additionalProperties: false,
            properties: { url: { type: "string", format: "uri" }, body: { type: "string" }, body_format: bodyFormat, account },
          }),
          responses: { "200": { description: "Edited or a structured error", content: { "application/json": { schema: { $ref: "#/components/schemas/PublishResult" } } } } },
        },
      },
      "/v1/reddit/posts/preview": {
        post: {
          operationId: "previewRedditPost",
          "x-openai-isConsequential": false,
          summary: "Prepare a Reddit post preview",
          description: "Fills the exact Reddit form in the authenticated browser but does not click Post. Use this when the user explicitly wants to inspect/review a preview before publishing, not as a mandatory extra confirmation step. If this preview occurs during a retry of content the user already explicitly authorized earlier in the conversation, that prior authorization remains valid for the unchanged content/target and you should publish it without asking again.",
          requestBody: jsonBody({
            type: "object", required: ["subreddit", "title"], additionalProperties: false,
            properties: {
              subreddit: { type: "string", description: "Subreddit name without r/." },
              title: { type: "string" }, body: { type: "string" }, body_format: bodyFormat, url: { type: "string", format: "uri" },
              flair: { type: "string", description: "Visible flair label, if required." }, account,
              openaiFileIdRefs: {
                type: "array", minItems: 1, maxItems: 4, items: { type: "string" },
                description: "Images uploaded or generated in the current ChatGPT conversation. Attach 1–4 image files. ChatGPT replaces these references with short-lived download objects at runtime. Do not combine with url.",
              },
            },
          }),
          responses: { "200": previewResponse },
        },
      },
      "/v1/reddit/comments/preview": {
        post: {
          operationId: "previewRedditComment",
          "x-openai-isConsequential": false,
          summary: "Prepare a Reddit comment preview",
          description: "Fills a comment/reply form for the exact canonical Reddit permalink but does not submit it. Do not use this as an extra confirmation step. If this is a retry of an exact unchanged comment/reply the user already explicitly authorized earlier in the conversation, that authorization remains valid and the next step is publishPublication without another chat confirmation.",
          requestBody: jsonBody({
            type: "object", required: ["url", "body"], additionalProperties: false,
            properties: { url: { type: "string", format: "uri" }, body: { type: "string" }, body_format: bodyFormat, account },
          }),
          responses: { "200": previewResponse },
        },
      },
      "/v1/reddit/chats/replies/preview": {
        post: { operationId:"previewRedditChatReply", "x-openai-isConsequential":false, summary:"Prepare a Reddit Chat reply preview", description:"Reads the exact Reddit Chat room and binds the requested reply text to it without sending. Use only when the user asks to inspect/review first or content changed. Prior authorization for exact unchanged text/room remains valid and publishPublication is next without another chat confirmation.", requestBody:jsonBody({type:"object",required:["room_id","body"],additionalProperties:false,properties:{room_id:{type:"string",description:"Exact room_id returned by getRedditChats."},body:{type:"string"},account}}), responses:{"200":previewResponse} },
      },
      "/v1/reddit/chats/direct/preview": {
        post: { operationId:"previewRedditDirectMessage", "x-openai-isConsequential":false, summary:"Verify a Reddit direct-message recipient and preview the text", description:"Read-only with respect to the recipient: verifies the Reddit username/account id and checks for an existing direct room. It never creates a room, invite, message request, or message. If no existing Chat is found, publish will create one.", requestBody:jsonBody({type:"object",required:["recipient_username","body"],additionalProperties:false,properties:{recipient_username:{type:"string",description:"Exact Reddit username, for example top_comment.author."},recipient_fullname:{type:"string",description:"Optional verified t2_ id, for example top_comment.author_fullname."},body:{type:"string"},account}}), responses:{"200":previewResponse} },
      },
      "/v1/reddit/edits/preview": {
        post: {
          operationId: "previewRedditEdit",
          "x-openai-isConsequential": false,
          summary: "Prepare an edit of the owner's Reddit content",
          description: "Opens the exact owned Reddit post/comment and fills the edit form without saving it. Do not use this as an extra confirmation step. If this is a retry of an exact unchanged edit the user already explicitly authorized earlier in the conversation, that authorization remains valid and the next step is publishPublication without another chat confirmation.",
          requestBody: jsonBody({
            type: "object", required: ["url", "body"], additionalProperties: false,
            properties: { url: { type: "string", format: "uri" }, body: { type: "string" }, body_format: bodyFormat, account },
          }),
          responses: { "200": previewResponse },
        },
      },
      "/v1/reddit/deletes/preview": {
        post: {
          operationId: "previewRedditDelete",
          "x-openai-isConsequential": false,
          summary: "Prepare deletion of the owner's Reddit content",
          description: "Resolves the exact owned Reddit target and prepares deletion without clicking the final delete confirmation.",
          requestBody: jsonBody({
            type: "object", required: ["url"], additionalProperties: false,
            properties: { url: { type: "string", format: "uri" }, account },
          }),
          responses: { "200": previewResponse },
        },
      },
      "/v1/publications/{draft_id}/publish": {
        post: {
          operationId: "publishPublication",
          "x-openai-isConsequential": true,
          summary: "Publish the exact previously previewed content",
          description: "CONSEQUENTIAL: publishes an existing live preview. Use this legacy two-step endpoint when a preview was intentionally requested or already exists. If the conversation already contains an explicit, unrevoked authorization to publish/save this exact unchanged Reddit content to this exact target, call this action immediately and do not ask another chat confirmation, even when the latest user message is only a retry/status acknowledgement after a transient failure. Authorization stops carrying forward only if withdrawn or if content/target materially changed. Safe to retry after a successful publish; the service will not publish the same draft twice.",
          parameters: [{ name: "draft_id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: jsonBody({
            type: "object", required: ["preview_digest"], additionalProperties: false,
            properties: { preview_digest: { type: "string", description: "Opaque digest returned by the preview action." } },
          }),
          responses: { "200": { description: "Published, already published, or a structured error", content: { "application/json": { schema: { $ref: "#/components/schemas/PublishResult" } } } } },
        },
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: {
        ActionResult: {
          type: "object", required: ["ok", "message"],
          properties: { ok: { type: "boolean" }, message: { type: "string" }, data: { type: "object", additionalProperties: true }, error_code: { type: "string" } },
        },
        PreviewResult: {
          type: "object", required: ["ok", "message"],
          properties: {
            ok: { type: "boolean" }, message: { type: "string" }, draft_id: { type: "string" }, preview_digest: { type: "string" },
            expires_at: { type: "string" }, preview: { type: "object", additionalProperties: true }, error_code: { type: "string" },
            authorization_policy: { type: "string", description: "For Reddit post/comment/chat-reply/edit previews: earlier explicit authorization for the exact unchanged content and target persists across transient failures and retry/status follow-ups." },
            next_step_if_already_authorized: { type: "string", enum: ["publishPublication"], description: "When prior explicit authorization is still valid, call this operation immediately instead of asking for another chat confirmation." },
          },
        },
        PublishResult: {
          type: "object", required: ["ok", "message"],
          properties: {
            ok: { type: "boolean" }, message: { type: "string" }, published_url: { type: "string" }, already_published: { type: "boolean" },
            warnings: { type: "array", items: { type: "string" } }, error_code: { type: "string" },
          },
        },
      },
    },
  };
}
