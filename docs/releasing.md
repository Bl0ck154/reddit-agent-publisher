# Release, npm, and MCP Registry

GitHub tags, npm packages and MCP Registry entries are published separately.
Do not claim a version is discoverable in a registry until a public lookup succeeds.

## Version checks

Keep the following in sync before creating a tag:
- package.json version and mcpName
- package-lock.json top-level and root package versions
- src/cli.ts version
- server.json version, packages[0].version and name
- CHANGELOG.md heading

The correct, case-sensitive name is io.github.Bl0ck154/reddit-mcp-publisher.
The npm package's mcpName must match server.json name byte-for-byte. GitHub OIDC
only grants ownership of the exact namespace io.github.Bl0ck154/*.

Run npm ci, npm run check and npm pack --dry-run in an isolated checkout.
A GitHub tag runs the release workflow, which checks those fields and creates
the GitHub Release. Do not retag or mutate a published version.

## npm publishing

The first public npm release was reddit-mcp-publisher@0.3.2 on 2 November 2026.
Version 0.3.3 fixes a case-sensitive MCP ownership mismatch. The contents of an
already published npm version cannot be edited, so this requires a new version.

Publish a verified tag using npm on an authenticated, trusted machine.
If npm requires 2FA, use npm stage publish and have the account owner approve
the staged release on npmjs.com. No 2FA codes or npm tokens need to be pasted into
GitHub or an AI conversation.

npm Trusted Publishing was configured on 2 November 2026 for GitHub owner
Bl0ck154, repository reddit-mcp-publisher and workflow publish-npm.yml.
Version 0.3.4 was successfully published using GitHub Actions OIDC Trusted Publishing without manual 2FA. GitHub Actions run 41369381829 succeeded with signed provenance; the package became public after npm publish-time scanning. MCP Registry v0.3.4 was published by GitHub Actions run 41369968758 and independently verified active. The npm workflow is manual and uses GitHub OIDC; verify a published version with:

    npm view reddit-mcp-publisher version
    npx -y reddit-mcp-publisher --help

Do not assume npm trusted publishing works until it has been configured and
a real publication attempt succeeds.

## Official MCP Registry

After the matching npm version is public, trigger the GitHub Actions workflow
Publish MCP Registry (owner initiated) with the exact released version.
The workflow checks that both registries and the release manifest agree, then
authenticates with GitHub Actions OIDC, validates server.json and publishes it.

If the registry responds with a namespace permission error, compare the exact
GitHub username casing from the 403 error with server.json name and the npm
package's mcpName. Do not alter an immutable published version or claim that
a manifest-only change fixes mismatched npm metadata.

Official docs: https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx

## After releasing

Verify the GitHub Release, public npm version, registry listing and a clean
install. Update the distribution status and link real user reports from
docs/showcase.md once independently verified.
