export function buildActionsOpenApi(baseUrl: string): Record<string, unknown> {
  const server = baseUrl.replace(/\/$/, "");
  const account = { type: "string", default: "default", description: "Publisher account id. Usually leave as default." };
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
          description: "Read-only. Use an exact Reddit post or comment permalink. Returns the post, nested comments, and the targeted comment when the URL points to one.",
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
      "/v1/reddit/posts/publish": {
        post: {
          operationId: "publishRedditPost",
          "x-openai-isConsequential": true,
          summary: "Publish a finalized Reddit post in one step",
          description: "CONSEQUENTIAL. Use when the user has already explicitly asked to publish/post the finalized content. The server internally prepares and verifies a live Reddit preview, then publishes that exact content. Do not ask for an additional chat confirmation before calling this action; ChatGPT's action-approval UI handles any required approval.",
          requestBody: jsonBody({
            type: "object", required: ["subreddit", "title"], additionalProperties: false,
            properties: {
              subreddit: { type: "string", description: "Subreddit name without r/." },
              title: { type: "string" }, body: { type: "string" }, url: { type: "string", format: "uri" },
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
          description: "CONSEQUENTIAL. Use when the user has already explicitly asked to post the finalized comment/reply to the exact Reddit permalink. The server internally prepares and verifies a live preview before submitting. Do not ask for an additional chat confirmation before calling this action.",
          requestBody: jsonBody({
            type: "object", required: ["url", "body"], additionalProperties: false,
            properties: { url: { type: "string", format: "uri" }, body: { type: "string" }, account },
          }),
          responses: { "200": { description: "Published or a structured error", content: { "application/json": { schema: { $ref: "#/components/schemas/PublishResult" } } } } },
        },
      },
      "/v1/reddit/posts/preview": {
        post: {
          operationId: "previewRedditPost",
          "x-openai-isConsequential": false,
          summary: "Prepare a Reddit post preview",
          description: "Fills the exact Reddit form in the authenticated browser but does not click Post. Use this when the user explicitly wants to inspect/review a preview before publishing, not as a mandatory extra confirmation step.",
          requestBody: jsonBody({
            type: "object", required: ["subreddit", "title"], additionalProperties: false,
            properties: {
              subreddit: { type: "string", description: "Subreddit name without r/." },
              title: { type: "string" }, body: { type: "string" }, url: { type: "string", format: "uri" },
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
          description: "Fills a comment/reply form for the exact canonical Reddit permalink but does not submit it.",
          requestBody: jsonBody({
            type: "object", required: ["url", "body"], additionalProperties: false,
            properties: { url: { type: "string", format: "uri" }, body: { type: "string" }, account },
          }),
          responses: { "200": previewResponse },
        },
      },
      "/v1/reddit/edits/preview": {
        post: {
          operationId: "previewRedditEdit",
          "x-openai-isConsequential": false,
          summary: "Prepare an edit of the owner's Reddit content",
          description: "Opens the exact owned Reddit post/comment and fills the edit form without saving it.",
          requestBody: jsonBody({
            type: "object", required: ["url", "body"], additionalProperties: false,
            properties: { url: { type: "string", format: "uri" }, body: { type: "string" }, account },
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
          description: "CONSEQUENTIAL: publishes an existing live preview. Use this legacy two-step endpoint when a preview was intentionally requested or already exists. If the user has already explicitly asked to publish finalized Reddit content, prefer the one-step publishRedditPost/publishRedditComment action instead of asking for another chat confirmation. Safe to retry after a successful publish; the service will not publish the same draft twice.",
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
