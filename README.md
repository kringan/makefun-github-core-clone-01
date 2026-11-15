[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![Rank](https://make.fun/badge/github-core-clone-01/kringan/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![Reward](https://make.fun/badge/github-core-clone-01/kringan/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

# github-core-clone-01 — a GitHub-compatible git forge

A standalone server (Node 22, standard library only) that speaks the four
surfaces a GitHub client expects, all over one in-memory store:

- **git smart HTTP** at `/{owner}/{repo}.git`: upload-pack protocol v2
  (with a v0 fallback), receive-pack v0, shallow fetch and deepen,
  sideband pack framing, per-ref push reports with fast-forward checks.
- **REST v3** under `/api/v3`: repositories, branches, commits, refs,
  contents, labels, issues, comments and pull requests, with pagination
  via `Link: rel="next"` and an `X-GitHub-Request-Id` on every reply.
- **GraphQL v4** at `/api/graphql`: viewer and repository reads, `__type`
  feature probes, issue and pull-request connections with cursor
  pagination, `node(id:)` Relay ids, the five mutations, and batched
  operation documents in one request.
- **MCP** at `/mcp`: JSON-RPC 2.0 over Streamable HTTP, modern
  `server/discover` (revision 2026-07-28) with the legacy `initialize`
  handshake kept, and six tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`).

Built for the [github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01) on make.fun.

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the entry <-> env lifecycle: it binds an ephemeral port,
registers it at `$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done`
until the trial ends and exits 0. `MAKEFUN_ENV_URL` is required;
`MAKEFUN_SHOP_TOKEN` is the bearer token the server accepts (when unset,
any non-empty bearer is accepted, for local testing only).

## Layout

- `git.ts` — git objects, packs (write full entries, read thin packs with
  OFS/REF deltas), pkt-line framing.
- `store.ts` — the forge: repositories, refs, objects, labels, issues,
  pull requests, trees, three-way merges and squash merges.
- `gitproto.ts` — smart HTTP: ref advertisement (v2 and v0), ls-refs,
  fetch planning (wants/haves/shallow/deepen), receive-pack reports.
- `rest.ts` — REST v3 handlers.
- `graphql.ts` — a small GraphQL parser and executor for the documented
  surface.
- `mcp.ts` — MCP JSON-RPC methods and the six tools.
- `app.ts` — the HTTP server: routing, bearer auth, request ids.
- `main.ts` — the lifecycle: bind, register, poll done, exit.

## License

MIT.
