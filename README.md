# Forge — a GitHub-compatible git forge in one process

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/hendraaragaki/forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/hendraaragaki/forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge built for [make.fun's
github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01).
One Node 22 process, standard library only — no git binary, no outside
service, no proxy, no package install. It serves the same shared store over
four surfaces:

| Surface | Path | What it does |
| --- | --- | --- |
| Git smart HTTP | `/{owner}/{repo}.git` | upload-pack v2 (+ v0 fallback), receive-pack v0 |
| REST v3 | `/api/v3` | repos, contents, labels, issues, pull requests |
| GraphQL v4 | `/api/graphql` | viewer, repository, issues, PRs, mutations |
| MCP | `/mcp` | JSON-RPC 2.0 over Streamable HTTP, 6 tools |

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own. There is nothing to install: the program imports
`node:http` and its own modules only.

## The lifecycle (main.ts, unchanged from the starter)

The env is a server the harness starts beside yours. Its origin is in
`MAKEFUN_ENV_URL`.

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one.
   Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <port>}`.
   The env records the address the request came from plus that port as the
   base URL. The first register wins.
3. **Wait.** Long-poll `GET $MAKEFUN_ENV_URL/done` until `{"done": true}`,
   then exit 0.

## Layout

```
main.ts        the lifecycle above (starter file, kept as is)
app.ts         the HTTP server: dispatch git -> rest -> graphql -> mcp -> 404 JSON
store.ts       the shared in-memory store (repos, issues, PRs, labels,
               contents, git objects/refs) + the deterministic seed data
util.ts        HTTP helpers, GitHub REST serializers, auth
git.ts         git smart HTTP: pkt-lines, packfiles (write + delta-resolving
               read), upload-pack v2/v0, receive-pack v0
rest.ts        REST v3
graphql.ts     GraphQL v4
mcp.ts         MCP (Streamable HTTP, revisions 2026-07-28 + legacy)
```

The store is deterministic: replay produces byte-identical state (sequence
numbers, no timestamps/ports/dates in stored state). All four surfaces read
and write the same store, so an issue created over MCP shows up in REST and
GraphQL with the same id, and a branch pushed over git is the head a pull
request merges.

## Git (git.ts)

- **pkt-line** framing, strict validation (malformed input -> HTTP 400, the
  server stays up).
- **Packfiles**: delta-free writing (`deflateSync`, SHA-1 trailer); reading
  resolves OFS_DELTA and REF_DELTA, including thin packs whose REF_DELTA
  bases live in the repo store, with trailer-checksum and size verification.
- **upload-pack v2** (when `Git-Protocol: version=2`): capability
  advertisement (`fetch=shallow filter`, `ls-refs=unborn`,
  `object-format=sha1`), `ls-refs` with `peel`, `symrefs`, `unborn` and
  server-side `ref-prefix` filtering, `fetch` with want/have negotiation and
  shallow support (`deepen N`, `deepen-since`, `deepen-not`, `shallow-info`
  with `shallow`/`unshallow`). Object selection is want-reachable minus
  have-reachable, where the have-walk stops at the client's shallow
  boundaries.
- **upload-pack v0 fallback**: `# service=git-upload-pack` preamble,
  `side-band-64k thin-pack ofs-delta shallow multi_ack_detailed`,
  peeled `^{}` lines, empty-repo `capabilities^{}` pseudo-ref.
- **receive-pack v0 only**: `# service=git-receive-pack` preamble
  advertising `report-status side-band-64k delete-refs`; the pushed pack is
  unpacked first (objects are stored even if refs are refused, as git does),
  then per-ref decisions — **fast-forward only** (non-fast-forward refused
  with the exact reason `non-fast-forward`, the ref unmoved), mixed ok/ng
  reports applied per-ref, deletions honoured, branch creates require a
  commit object, stale `oldOid` -> `old value mismatch`.
- **Two real-git compatibility details** (found by testing against a real
  git client, not just the kit's client):
  - The v2 fetch response carries an `acknowledgments` section **only when
    the client sent `have` lines**. A fresh clone sends none, and real git
    then expects the response to open with the `packfile` section; sending
    `acknowledgments` there dies with `expected 'packfile', received
    'acknowledgments'`. With haves, the server answers `ACK <oid>` for each
    held have plus `ready`.
  - `ls-refs` lists HEAD when it matches a `ref-prefix` (real git clones
    ask for `ref-prefix HEAD`). Without the HEAD symref, a clone warns
    `remote HEAD refers to nonexistent ref, unable to checkout`.

## REST v3 (rest.ts)

Repos (create/list/get/patch/delete), contents (PUT create 201 / update 200 /
409 on a stale sha; DELETE 200 `{commit:{sha}}`), labels, issues (201; 422 on
an unknown label), pull requests (201 open with head/base; GET 200/404; PUT
`.../merge` 200 `{sha, merged:true, message}` with a squash commit on the
default branch; 404 unknown, 405 conflicted). Every reply is
`application/json` with a non-empty `X-GitHub-Request-Id`; errors are JSON
`{message}`; unknown routes are 404 JSON (never HTML); malformed JSON is 400.
Auth is `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`; no token is 401; a repo
under another owner is 404, never 403. `GET /api/v3/` is 200 with
`X-OAuth-Scopes`; `GET /api/v3/meta` is 200 with a non-empty
`installed_version`; `GET /api/v3/user/repos` is a 200 list with
`Link rel="next"` pagination.

## GraphQL v4 (graphql.ts)

`POST {query, variables}`; unauthenticated is exactly 401. Introspection
describes `Issue` (id, number, title, state, body), `PullRequest` (id, number,
headRefName, baseRefName, mergeable, state, merged, files), `Repository` (id,
databaseId, name, nameWithOwner, owner, defaultBranchRef, viewerPermission,
hasIssuesEnabled, issue, issues, pullRequests, pullRequest), and the
`SearchType` enum includes `ISSUE`. `repository.issues` with
`orderBy: CREATED_AT DESC` orders by createdAt (ties by number DESC), and
`states: [OPEN]` omits closed issues. `createPullRequest` (repository id +
a head branch pushed over git) opens a PR that REST reads back. Two operation
documents in one body answer two results in order; an unknown field is HTTP
200 with an `errors` array naming it; an unknown repo is
`data.repository: null` with no errors.

## MCP (mcp.ts)

JSON-RPC 2.0 over Streamable HTTP (`application/json` or SSE), each request
under 3 s. Revision `2026-07-28` (via `server/discover`, whose
`supportedVersions` is a non-empty list of `YYYY-MM-DD` dates) or a handshake
revision (2025-11-25 or earlier) via `initialize` +
`notifications/initialized` + optional `Mcp-Session-Id`. `tools/list` offers
6 tools — `create_repo`, `get_repo`, `create_issue`, `list_issues`,
`create_pull_request`, `merge_pull_request` — each with a non-empty
description and an `inputSchema` of type `object`; two `tools/list` calls are
byte-identical. Two concurrent `tools/call`s keep their own JSON-RPC ids.
Arguments follow github-mcp-server's shapes; an unknown tool is JSON-RPC
`-32602` or `-32601` (never HTTP 500); a missing required argument is
`isError: true` or `-32602`; a non-JSON body is HTTP 400 with `-32700`; no
`Authorization` is 401. Tools act on the same store as REST (same ids across
reads).

## Verification

Against the kit's own conformance suite (run locally, `node
--experimental-strip-types`):

- **120/120 checks pass** — git 30/30, repos 15/15, issues 15/15, pulls
  20/20, graphql 20/20, mcp 15/15, protocol 5/5.
- **End-to-end, real git client**: 39/39 — clone, push, non-fast-forward
  refusal, second clone, feature-branch push, PR create + squash merge, and
  the same issue visible across REST, GraphQL and MCP.
- **Benchmark** (kit's `runBenchmark`, 3 rounds each, local VM):
  push p50 394 ms (50/50), clone p50 166 ms (34/50), read p50 737 ms
  (49/50), write p50 129 ms (43/50) — **176/200 performance points**,
  against the house reference forge's 100/200 at its own T_refs
  (push 1640.82 ms, clone 266.941 ms, read 2759.715 ms, write 348.965 ms).
  Estimated total: 600 features + 200 MCP + 176 perf = **976/1000**,
  above the reference's 900/1000. Production-cluster timings will differ
  from local ones, but the margin is measured in the same environment as the
  reference, so it should carry over.

Known limits: packfiles are delta-free (valid, and the suite accepts them;
deltas would only save bytes). `filter` in a fetch is ignored (the client
never sends it). `report-status-v2` is not advertised (the client falls back
to `report-status`).

## License

MIT. See [LICENSE](LICENSE).
