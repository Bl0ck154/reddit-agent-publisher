# ChatGPT / Custom GPT Actions

Reddit Agent Publisher includes a real HTTP Actions gateway in `src/actions-gateway.ts`. It exposes a narrow Reddit context + publishing workflow, not arbitrary browser or RPC access.

## Workflow

Read-only context Actions can resolve the owner's existing Reddit content without mutation:

```text
getMyRedditActivity / getRedditInbox
        ↓
getRedditThread
        ↓
context-aware draft
```

For finalized posts/comments, use the one-step consequential write path:

```text
publishRedditPost / publishRedditComment / publishRedditEdit
        ↓
platform action approval when required
        ↓
server performs live preview verification and publishes the exact content
```

Use `previewRedditPost` / `previewRedditComment` only when the owner explicitly wants to inspect the live preview first. Preview endpoints never click Reddit's final Post/Comment/Save/Delete action. The legacy consequential `publishPublication` endpoint remains available to publish an exact still-valid `draft_id + preview_digest` from such a preview.

## Start the daemon

The daemon owns the live browser preview state and authenticated Reddit context, so it must stay running while CLI, MCP, and Actions clients use it.

```bash
npm run build
export PUBLISHER_MASTER_KEY_FILE="$HOME/.local/share/reddit-agent-publisher/master.key"
npm start
```

Create the master key once:

```bash
mkdir -p "$HOME/.local/share/reddit-agent-publisher"
openssl rand 32 > "$HOME/.local/share/reddit-agent-publisher/master.key"
chmod 600 "$HOME/.local/share/reddit-agent-publisher/master.key"
```

## Start the Actions gateway

Create a separate bearer key:

```bash
openssl rand -hex 32 > "$HOME/.local/share/reddit-agent-publisher/actions.key"
chmod 600 "$HOME/.local/share/reddit-agent-publisher/actions.key"

export PUBLISHER_ACTIONS_API_KEY_FILE="$HOME/.local/share/reddit-agent-publisher/actions.key"
npm run start:actions
```

By default it listens only on `127.0.0.1:8791`. Put it behind your own HTTPS reverse proxy before connecting a Custom GPT.

The generated schema is available at:

```text
https://YOUR-PUBLISHER-HOST/openapi.json
```

The built-in privacy page is available at `/privacy`.

## Supported Actions

Read-only:

- `getPublisherStatus`
- `getRedditRules`
- `getRedditFlairs`
- `getRedditThread`
- `getMyRedditActivity`
- `getRedditInbox`

Preview-only, no external write:

- `previewRedditPost`
- `previewRedditComment`
- `previewRedditEdit`
- `previewRedditDelete`

External write:

- `publishRedditPost` — one-step consequential publish for finalized posts; internally performs live preview verification first.
- `publishRedditComment` — one-step consequential publish for finalized comments/replies; internally performs live preview verification first.
- `publishRedditEdit` — one-step consequential save for finalized edits of the owner's Reddit post body/comment text; Reddit titles are not editable.
- `publishPublication` — legacy two-step consequential publish for an exact existing preview.

### Reddit context

The gateway reads Reddit through the same authenticated browser session used for publishing. No separate Reddit Data API application or OAuth credentials are required for these context operations.

Typical flow:

1. `getMyRedditActivity` locates a recent owner post/comment when no permalink was provided.
2. `getRedditInbox` finds unread replies/messages when the owner asks who responded.
3. `getRedditThread` loads the exact post/comment and nested comment context before drafting a response.
4. If the owner then says to post the finalized reply, call `publishRedditComment` directly. Use a separate preview only when the owner asks to inspect it before publishing.

`getRedditThread` accepts a canonical Reddit post or comment permalink. When the target is a comment, the response includes `target_comment` in addition to the surrounding nested comment tree. For post URLs it also returns `top_comment` (highest score among returned top-level comments), `newest_comment`, and `oldest_comment`, each with an exact permalink suitable for replying.

### Reddit images

`previewRedditPost` accepts 1–4 ChatGPT conversation images through `openaiFileIdRefs`. Files are downloaded immediately into the protected local artifacts directory, validated by payload signature, and used only for the matching preview.

### Reddit text formatting

Post bodies, comments/replies, and edits accept `body_format: "plain" | "markdown"` (default `plain`). Use `markdown` for Reddit Markdown such as `**bold**`, `*italic*`, headings, lists, quotes, links, code, and spoiler syntax. The browser adapter switches to Reddit's Markdown editor and fails safely if it cannot verify that editor, instead of publishing raw Markdown markers by accident.

Recommended Custom GPT instructions are in [`actions/gpt-instructions.md`](../actions/gpt-instructions.md).
