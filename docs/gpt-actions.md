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

External writes stay separate:

```text
previewRedditPost / previewRedditComment / previewRedditEdit / previewRedditDelete
        ↓
show the exact preview to the owner
        ↓
explicit confirmation
        ↓
publishPublication
```

Reddit context, status, rules, flairs, and preview endpoints are marked non-consequential. Context Actions only read through the same authenticated browser session and never mutate Reddit. Preview endpoints never click Reddit's final Post/Comment/Save/Delete action. `publishPublication` is consequential and accepts only the exact still-valid `draft_id + preview_digest` from a matching preview.

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

- `publishPublication`

### Reddit context

The gateway reads Reddit through the same authenticated browser session used for publishing. No separate Reddit Data API application or OAuth credentials are required for these context operations.

Typical flow:

1. `getMyRedditActivity` locates a recent owner post/comment when no permalink was provided.
2. `getRedditInbox` finds unread replies/messages when the owner asks who responded.
3. `getRedditThread` loads the exact post/comment and nested comment context before drafting a response.
4. A separate preview Action prepares a reply; publishing still requires explicit confirmation.

`getRedditThread` accepts a canonical Reddit post or comment permalink. When the target is a comment, the response includes `target_comment` in addition to the surrounding nested comment tree.

### Reddit images

`previewRedditPost` accepts 1–4 ChatGPT conversation images through `openaiFileIdRefs`. Files are downloaded immediately into the protected local artifacts directory, validated by payload signature, and used only for the matching preview.

Recommended Custom GPT instructions are in [`actions/gpt-instructions.md`](../actions/gpt-instructions.md).
