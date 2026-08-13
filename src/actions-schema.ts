export function buildActionsSchema(baseUrl: string): Record<string, unknown> {
  const error = {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      message: { type: "string" },
      error: { type: "string" }
    }
  };

  const previewResponse = {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      draft_id: { type: "string" },
      preview_digest: { type: "string" },
      preview: { type: "object", additionalProperties: true },
      message: { type: "string" }
    }
  };

  const protectedOperation = (operationId: string, summary: string, consequential: boolean, requestBody?: Record<string, unknown>, parameters?: unknown[]) => ({
    operationId,
    summary,
    security: [{ bearerAuth: [] }],
    "x-openai-isConsequential": consequential,
    ...(parameters ? { parameters } : {}),
    ...(requestBody ? { requestBody: { required: true, content: { "application/json": { schema: requestBody } } } } : {}),
    responses: {
      "200": { description: "Success", content: { "application/json": { schema: consequential ? error : previewResponse } } },
      "400": { description: "Invalid request", content: { "application/json": { schema: error } } },
      "401": { description: "Unauthorized", content: { "application/json": { schema: error } } }
    }
  });

  return {
    openapi: "3.1.0",
    info: {
      title: "Reddit Agent Publisher Actions",
      version: "0.1.0",
      description: "Restricted owner-controlled Reddit publishing actions. Preview operations do not submit content; publishing is a separate consequential action."
    },
    servers: [{ url: baseUrl.replace(/\/$/, "") }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" }
      }
    },
    paths: {
      "/v1/status": {
        get: protectedOperation("getPublisherStatus", "Read Reddit publisher status", false, undefined, [
          { name: "account", in: "query", required: false, schema: { type: "string", default: "default" } }
        ])
      },
      "/v1/reddit/rules": {
        get: protectedOperation("getRedditRules", "Read subreddit rules", false, undefined, [
          { name: "subreddit", in: "query", required: true, schema: { type: "string" } },
          { name: "account", in: "query", required: false, schema: { type: "string", default: "default" } }
        ])
      },
      "/v1/reddit/flairs": {
        get: protectedOperation("getRedditFlairs", "Read subreddit post flairs", false, undefined, [
          { name: "subreddit", in: "query", required: true, schema: { type: "string" } },
          { name: "account", in: "query", required: false, schema: { type: "string", default: "default" } }
        ])
      },
      "/v1/reddit/posts/preview": {
        post: protectedOperation("previewRedditPost", "Prepare a Reddit post preview", false, {
          type: "object",
          required: ["subreddit", "title"],
          properties: {
            subreddit: { type: "string" },
            title: { type: "string" },
            body: { type: "string" },
            url: { type: "string", format: "uri" },
            flair: { type: "string" },
            account: { type: "string", default: "default" }
          },
          additionalProperties: false
        })
      },
      "/v1/reddit/comments/preview": {
        post: protectedOperation("previewRedditComment", "Prepare a Reddit comment preview", false, {
          type: "object",
          required: ["url", "body"],
          properties: {
            url: { type: "string", format: "uri" },
            body: { type: "string" },
            account: { type: "string", default: "default" }
          },
          additionalProperties: false
        })
      },
      "/v1/reddit/edit/preview": {
        post: protectedOperation("previewRedditEdit", "Prepare an edit preview", false, {
          type: "object",
          required: ["url", "body"],
          properties: {
            url: { type: "string", format: "uri" },
            body: { type: "string" },
            account: { type: "string", default: "default" }
          },
          additionalProperties: false
        })
      },
      "/v1/reddit/delete/preview": {
        post: protectedOperation("previewRedditDelete", "Prepare a delete preview", false, {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string", format: "uri" },
            account: { type: "string", default: "default" }
          },
          additionalProperties: false
        })
      },
      "/v1/publications/publish": {
        post: protectedOperation("publishPublication", "Publish the exact current preview", true, {
          type: "object",
          required: ["draft_id", "preview_digest"],
          properties: {
            draft_id: { type: "string", format: "uuid" },
            preview_digest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" }
          },
          additionalProperties: false
        })
      }
    }
  };
}
