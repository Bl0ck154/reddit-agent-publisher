# Release, npm, and MCP Registry

These are **three distinct publication steps**. A GitHub tag/release does not create an npm package; an npm package does not register an MCP server. Do not announce a channel as live until its verification succeeds.

## Version and preflight

- Keep `package.json`, `package-lock.json`, `src/cli.ts`, `server.json` and the new changelog heading on the same version.
- Run `npm ci && npm run check` and `npm pack --dry-run` on a development machine or CI. Never run unnecessary builds on a shared production server.
- Smoke-test the packed executable, the `setup --help` entry point, and the generated MCP client config in an isolated environment.
- Merge a reviewed PR and wait for its CI to succeed before tagging.

## GitHub Release

The `release.yml` workflow runs on tags `v*`. It checks the tag against package/lock/CLI/registry metadata, runs the suite, checks the package archive, and creates the GitHub Release with generated notes.

```bash
git checkout main && git pull --ff-only
git tag v0.3.2
git push origin v0.3.1
```

Use the current version rather than copying `v0.3.1` after a later bump. Check the [Releases page](https://github.com/Bl0ck154/reddit-mcp-publisher/releases). Do not retag a published version.

## First npm publication (owner action required)

As of 2026-11-02 the public `reddit-mcp-publisher` package returns npm E404 and the production server has no authenticated npm account. The first publication therefore **has not happened**.

1. Verify the npm account owns or can claim the package name; enable 2FA and login on a trusted development machine, not via an AI conversation.
2. From the verified release commit and a clean checkout, run `npm ci && npm run check && npm pack --dry-run`.
3. Run `npm publish --access public` from that trusted machine (may require interactive 2FA). Never paste tokens into GitHub issues.
4. Confirm `npm view reddit-mcp-publisher version`, then test `npx -y reddit-mcp-publisher --help` and setup in a disposable environment.

After the first publication, configure **npm Trusted Publishing** under the package settings for GitHub owner `Bl0ck154`, repository `reddit-mcp-publisher`, workflow filename `publish-npm.yml` with permission to publish. The manually dispatched `publish-npm.yml` workflow uses GitHub Actions OIDC with Node 24/npm 11+; it refuses mismatched versions. It is intentionally not automatic on every git tag because registry access and ownership must be established first. The workflow checks out the exact release tag: later changes to main cannot be published as an older version.

Official guide: [npm Trusted Publishers](https://docs.npmjs.com/trusted-publishers/).

## MCP Registry (after npm)

The `server.json` manifest and `package.json#mcpName` are versioned together.

```bash
mcp-publisher validate server.json
mcp-publisher login github
mcp-publisher publish server.json
```

The MCP Registry requires the npm package version to be **publicly available first** and verifies package/namespace ownership. Do not claim discoverability before the publish command succeeds. After npm is live, run the `Publish official MCP Registry` GitHub Action with the exact released npm version. It checks the package first and uses GitHub OIDC, without storing credentials.

Official guide: [Publish an MCP server](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx).

## After releasing

Check GitHub Release, npm registry version, MCP listing, and one clean install. Change the README's npm-status warning and primary install snippet **only when** npm is really available. Link real independent user reports from [the showcase page](showcase.md) once submitted.
