# ChatGPT / Custom GPT Actions

Reddit Agent Publisher includes a real HTTP Actions gateway in `src/actions-gateway.ts`. It exposes only the narrow Reddit publishing workflow, not arbitrary browser or RPC access.

## Workflow

```text
previewRedditPost / previewRedditComment / previewRedditEdit / previewRedditDelete
        ↓
show the exact preview to the owner
        ↓
explicit confirmation
        ↓
publishPublication
```

Preview endpoints are marked non-consequential and never click Reddit's final Post/Comment/Save/Delete action. `publishPublication` is consequential and accepts only the exact still-valid `draft_id + preview_digest` from a matching preview.

## Start the daemon

The daemon owns the live browser preview state, so it must stay running while CLI, MCP, and Actions clients use it.

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

- `getPublisherStatus`
- `getRedditRules`
- `getRedditFlairs`
- `previewRedditPost`
- `previewRedditComment`
- `previewRedditEdit`
- `previewRedditDelete`
- `publishPublication`

`previewRedditPost` also accepts 1–4 ChatGPT conversation images through `openaiFileIdRefs`. Files are downloaded immediately into the protected local artifacts directory, validated by payload signature, and used only for the matching preview.

Recommended Custom GPT instructions are in [`actions/gpt-instructions.md`](../actions/gpt-instructions.md).
