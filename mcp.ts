// MCP surface for the forge: JSON-RPC 2.0 over Streamable HTTP at POST /mcp.
// Speaks both protocol eras the suite accepts:
//   modern 2026-07-28: server/discover (no handshake, no session); every request
//           declares its revision in _meta / the MCP-Protocol-Version header.
//   legacy 2025-11-25 and earlier: initialize + notifications/initialized, with an
//           optional Mcp-Session-Id.
// All tools act on the shared Store, so a repo/issue created over MCP reads back
// over /api/v3 as the same object with the same id.
//
// Node 22 stdlib only (node:http + the shared store/util). Erasable TypeScript only.
// No clock, no randomness, no network: the tools list is built once at module load
// and reused byte for byte, and every id echoed is the id the client sent.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';
import { VIEWER_LOGIN } from './store.ts';
import { isAuthorized, issueJson, parseJson, pathOf, pullJson, readBody, repoJson, sendJson } from './util.ts';

/** The revision this server speaks (and lists first in supportedVersions). */
const CURRENT_REVISION = '2026-07-28';
/** Every revision the server accepts, newest first. */
const SUPPORTED_REVISIONS: readonly string[] = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
/** The server identity every era answers with. */
const SERVER_INFO = { name: 'forge', version: '1.0.0' };

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_UNAUTHORIZED = -32001;

type JsonRpcId = string | number | null;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

function strProp(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

function tool(name: string, description: string, properties: Record<string, Record<string, unknown>>, required: string[]): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

/**
 * The six tools, built once and reused for every tools/list answer, so two calls
 * answer the same list byte for byte. Canonical github-mcp-server names; the
 * client maps its documented arguments onto these property names, and the server
 * additionally accepts the documented aliases at call time (see pickArg).
 * Required lists hold only properties the suite can always fill.
 */
const TOOLS: readonly ToolDef[] = Object.freeze([
  tool('create_repo', 'Create a new repository owned by the authenticated user.', {
    name: strProp('The name of the repository to create.'),
    owner: strProp('The login of the repository owner. Defaults to the authenticated user.'),
    description: strProp('A short description of the repository.'),
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: strProp('The login of the repository owner.'),
    repo: strProp('The name of the repository.'),
    full_name: strProp('The full name of the repository as "owner/repo". An alternative to owner and repo.'),
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: strProp('The login of the repository owner.'),
    repo: strProp('The name of the repository.'),
    full_name: strProp('The full name of the repository as "owner/repo". An alternative to owner and repo.'),
    title: strProp('The title of the issue.'),
    body: strProp('The body of the issue.'),
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository.', {
    owner: strProp('The login of the repository owner.'),
    repo: strProp('The name of the repository.'),
    full_name: strProp('The full name of the repository as "owner/repo". An alternative to owner and repo.'),
    state: { type: 'string', description: 'The state of the issues to list: open, closed, or all.', enum: ['open', 'closed', 'all'] },
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Create a pull request in a repository.', {
    owner: strProp('The login of the repository owner.'),
    repo: strProp('The name of the repository.'),
    full_name: strProp('The full name of the repository as "owner/repo". An alternative to owner and repo.'),
    title: strProp('The title of the pull request.'),
    body: strProp('The body of the pull request.'),
    head: strProp('The name of the branch containing the changes.'),
    base: strProp('The name of the branch the changes are pulled into.'),
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request in a repository.', {
    owner: strProp('The login of the repository owner.'),
    repo: strProp('The name of the repository.'),
    full_name: strProp('The full name of the repository as "owner/repo". An alternative to owner and repo.'),
    pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
  }, ['owner', 'repo', 'pull_number']),
]);

// ---------------------------------------------------------------- JSON-RPC plumbing

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function okResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function errorResult(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A date-shaped revision string (YYYY-MM-DD). */
function isRevision(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// ---------------------------------------------------------------- argument aliases

/** Normalize an argument name for matching: lowercase, every non-alphanumeric removed. */
function normKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The suite maps each documented argument onto the tool's own schema property by
 * exact normalized name, so a call normally arrives under the canonical property
 * names. These synonym tables (the same spellings checks-mcp.ts maps from) make
 * the server accept the documented aliases too, whatever name an argument came
 * under: owner/owner_login/org/user/login, repo/repository, head/head_branch,
 * pull_number/number, and a full_name carrying "owner/repo".
 */
const ARG_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  owner: ['owner', 'ownerlogin', 'org', 'organization', 'organisation', 'user', 'userlogin', 'login', 'account', 'namespace', 'ownername'],
  repo: ['repo', 'repository', 'repositoryname', 'reponame', 'reposlug', 'project', 'projectname'],
  name: ['name', 'repo', 'repository', 'repositoryname', 'reponame'],
  fullname: ['fullname', 'repofullname', 'repositoryfullname'],
  title: ['title', 'issuetitle', 'prtitle', 'pullrequesttitle', 'subject'],
  body: ['body', 'issuebody', 'description', 'content', 'text', 'comment'],
  head: ['head', 'headref', 'headbranch', 'pullrequesthead', 'prhead', 'source', 'sourceref', 'sourcebranch', 'from', 'frombranch', 'branch'],
  base: ['base', 'baseref', 'basebranch', 'pullrequestbase', 'prbase', 'target', 'targetref', 'targetbranch', 'into', 'intobranch'],
  pullnumber: ['pullnumber', 'pullrequestnumber', 'prnumber', 'number', 'issuenumber', 'index'],
  description: ['description', 'about', 'summary', 'body'],
  private: ['private', 'isprivate'],
  state: ['state', 'status'],
};

/** The value of the first argument whose normalized name matches `key` or one of its synonyms. */
function pickArg(args: Record<string, unknown>, key: string): unknown {
  const wanted = ARG_SYNONYMS[key] ?? [key];
  const byNorm = new Map<string, unknown>();
  for (const [k, v] of Object.entries(args)) {
    const n = normKey(k);
    if (!byNorm.has(n)) byNorm.set(n, v);
  }
  for (const synonym of wanted) {
    const found = byNorm.get(synonym);
    if (found !== undefined) return found;
  }
  return undefined;
}

function pickString(args: Record<string, unknown>, key: string): string | null {
  const value = pickArg(args, key);
  if (typeof value === 'string' && value !== '') return value;
  return null;
}

function pickBoolean(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = pickArg(args, key);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return fallback;
}

function pickPullNumber(args: Record<string, unknown>): number | null {
  const value = pickArg(args, 'pullnumber');
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** Owner + repo out of the arguments, splitting a full_name ("owner/repo") when either is missing. */
function resolveOwnerRepo(args: Record<string, unknown>): { owner: string | null; repo: string | null } {
  let owner = pickString(args, 'owner');
  let repo = pickString(args, 'repo');
  if ((owner === null || repo === null)) {
    const fullName = pickString(args, 'fullname');
    if (fullName !== null) {
      const slash = fullName.indexOf('/');
      if (slash > 0 && slash < fullName.length - 1) {
        if (owner === null) owner = fullName.slice(0, slash);
        if (repo === null) repo = fullName.slice(slash + 1);
      }
    }
  }
  return { owner, repo };
}

// ---------------------------------------------------------------- tools

/** The canonical tool a name serves: an exact match, or a server-prefixed name matched by suffix. */
function matchTool(name: string): string | null {
  const normalized = normKey(name);
  for (const def of TOOLS) {
    const canonical = normKey(def.name);
    if (normalized === canonical) return def.name;
  }
  for (const def of TOOLS) {
    const canonical = normKey(def.name);
    if (normalized.length > canonical.length && normalized.endsWith(canonical)) return def.name;
  }
  return null;
}

type ToolOutcome = { ok: true; data: unknown } | { ok: false; message: string };

function toolError(message: string): ToolOutcome {
  return { ok: false, message };
}

/** Run one tool against the store. Only called after the required arguments were checked present. */
function executeTool(store: Store, canonical: string, args: Record<string, unknown>): ToolOutcome {
  if (canonical === 'create_repo') {
    const { owner, repo: fullRepo } = resolveOwnerRepo(args);
    const name = pickString(args, 'name') ?? fullRepo;
    if (name === null) return toolError('create_repo requires a repository name');
    const repoOwner = owner ?? VIEWER_LOGIN;
    const existing = store.getRepo(repoOwner, name);
    if (existing !== undefined) return { ok: true, data: repoJson(store, existing) };
    const created = store.createRepo(repoOwner, name, pickString(args, 'description') ?? '', pickBoolean(args, 'private', false));
    return { ok: true, data: repoJson(store, created) };
  }
  if (canonical === 'get_repo') {
    const { owner, repo } = resolveOwnerRepo(args);
    const found = owner !== null && repo !== null ? store.getRepo(owner, repo) : undefined;
    if (found === undefined) return toolError(`Repository ${owner ?? '?'}/${repo ?? '?'} not found`);
    return { ok: true, data: repoJson(store, found) };
  }
  if (canonical === 'create_issue') {
    const { owner, repo } = resolveOwnerRepo(args);
    const found = owner !== null && repo !== null ? store.getRepo(owner, repo) : undefined;
    if (found === undefined) return toolError(`Repository ${owner ?? '?'}/${repo ?? '?'} not found`);
    const issue = store.createIssue(found, pickString(args, 'title') ?? '', pickString(args, 'body') ?? '');
    return { ok: true, data: issueJson(store, found, issue) };
  }
  if (canonical === 'list_issues') {
    const { owner, repo } = resolveOwnerRepo(args);
    const found = owner !== null && repo !== null ? store.getRepo(owner, repo) : undefined;
    if (found === undefined) return toolError(`Repository ${owner ?? '?'}/${repo ?? '?'} not found`);
    const state = (pickString(args, 'state') ?? 'open').toLowerCase();
    const issues = state === 'all' ? found.issues : found.issues.filter((i) => i.state === state);
    return { ok: true, data: issues.map((i) => issueJson(store, found, i)) };
  }
  if (canonical === 'create_pull_request') {
    const { owner, repo } = resolveOwnerRepo(args);
    const found = owner !== null && repo !== null ? store.getRepo(owner, repo) : undefined;
    if (found === undefined) return toolError(`Repository ${owner ?? '?'}/${repo ?? '?'} not found`);
    const pull = store.createPull(found, pickString(args, 'title') ?? '', pickString(args, 'body') ?? '', pickString(args, 'head') ?? '', pickString(args, 'base') ?? '');
    return { ok: true, data: pullJson(store, found, pull) };
  }
  if (canonical === 'merge_pull_request') {
    const { owner, repo } = resolveOwnerRepo(args);
    const found = owner !== null && repo !== null ? store.getRepo(owner, repo) : undefined;
    if (found === undefined) return toolError(`Repository ${owner ?? '?'}/${repo ?? '?'} not found`);
    const number = pickPullNumber(args);
    const pull = number !== null ? store.getPull(found, number) : undefined;
    if (pull === undefined) return toolError(`Pull request #${number ?? '?'} not found`);
    if (!pull.merged) {
      const sha = store.mergePull(found, pull);
      if (sha === null) return toolError(`Pull request #${number} cannot be merged: its head or base branch has no commit`);
    }
    return { ok: true, data: { ...pullJson(store, found, pull), sha: pull.mergeCommitSha, message: `Pull request #${pull.number} merged` } };
  }
  return toolError(`Unknown tool: ${canonical}`);
}

/** The required arguments that are missing after alias resolution (full_name counts for owner/repo). */
function missingRequired(canonical: string, args: Record<string, unknown>): string[] {
  const missing: string[] = [];
  if (canonical === 'create_repo') {
    if (pickString(args, 'name') === null && pickString(args, 'repo') === null && pickString(args, 'fullname') === null) missing.push('name');
    return missing;
  }
  const { owner, repo } = resolveOwnerRepo(args);
  if (owner === null) missing.push('owner');
  if (repo === null) missing.push('repo');
  if (canonical === 'create_issue' && pickString(args, 'title') === null) missing.push('title');
  if (canonical === 'create_pull_request') {
    if (pickString(args, 'title') === null) missing.push('title');
    if (pickString(args, 'head') === null) missing.push('head');
    if (pickString(args, 'base') === null) missing.push('base');
  }
  if (canonical === 'merge_pull_request' && pickPullNumber(args) === null) missing.push('pull_number');
  return missing;
}

// ---------------------------------------------------------------- JSON-RPC dispatch

/** The 2026-07-28 discover result: identity, capabilities and supported revisions in one answer. */
function discoverResult(): Record<string, unknown> {
  return {
    protocolVersion: CURRENT_REVISION,
    supportedVersions: [...SUPPORTED_REVISIONS],
    capabilities: { tools: {} },
    serverInfo: { ...SERVER_INFO },
    instructions: 'A GitHub-compatible git forge: create and read repositories, issues and pull requests through MCP tools.',
    _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
  };
}

/** One tools/call request: validate the tool and its arguments, run it, shape the result. */
function handleToolsCall(store: Store, id: JsonRpcId, params: unknown): Record<string, unknown> {
  if (!isRecord(params)) return errorResult(id, JSON_RPC_INVALID_PARAMS, 'Invalid params: tools/call params must be an object');
  const name = params.name;
  if (typeof name !== 'string' || name === '') return errorResult(id, JSON_RPC_INVALID_PARAMS, 'Invalid params: a tool name is required');
  const canonical = matchTool(name);
  if (canonical === null) return errorResult(id, JSON_RPC_INVALID_PARAMS, `Unknown tool: ${name}`);
  let args: Record<string, unknown> = {};
  if (isRecord(params.arguments)) args = params.arguments;
  else if (typeof params.arguments === 'string' && params.arguments.trim() !== '') {
    try {
      const parsed = JSON.parse(params.arguments) as unknown;
      if (isRecord(parsed)) args = parsed;
    } catch {
      return errorResult(id, JSON_RPC_INVALID_PARAMS, 'Invalid params: arguments is not a JSON object');
    }
  }
  const missing = missingRequired(canonical, args);
  if (missing.length > 0) return errorResult(id, JSON_RPC_INVALID_PARAMS, `Missing required argument(s): ${missing.join(', ')}`);
  let outcome: ToolOutcome;
  try {
    outcome = executeTool(store, canonical, args);
  } catch (error) {
    outcome = toolError(messageOf(error));
  }
  if (!outcome.ok) {
    return okResult(id, { content: [{ type: 'text', text: JSON.stringify({ error: outcome.message }) }], isError: true });
  }
  return okResult(id, {
    content: [{ type: 'text', text: JSON.stringify(outcome.data) }],
    structuredContent: outcome.data,
    isError: false,
  });
}

/**
 * One JSON-RPC request object. Returns the response object, or null for a
 * notification (no id), which gets no response at all.
 */
function handleRpc(store: Store, value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return errorResult(null, JSON_RPC_INVALID_REQUEST, 'Invalid Request: expected a JSON-RPC object');
  const hasId = 'id' in value;
  const id: JsonRpcId = hasId ? (value.id as JsonRpcId) : null;
  const method = value.method;
  if (typeof method !== 'string' || method === '') {
    if (!hasId) return null;
    return errorResult(id, JSON_RPC_INVALID_REQUEST, 'Invalid Request: a method is required');
  }
  // A notification (no id member) never gets a response, whatever the method.
  if (!hasId) return null;
  const params = isRecord(value.params) ? value.params : {};
  if (method === 'server/discover') return okResult(id, discoverResult());
  if (method === 'initialize') {
    const requested = isRecord(value.params) && typeof value.params.protocolVersion === 'string' ? value.params.protocolVersion : null;
    const metaVersion = isRecord(params._meta) && typeof params._meta['io.modelcontextprotocol/protocolVersion'] === 'string'
      ? (params._meta['io.modelcontextprotocol/protocolVersion'] as string)
      : null;
    const negotiated = requested !== null && isRevision(requested) ? requested : metaVersion !== null && isRevision(metaVersion) ? metaVersion : CURRENT_REVISION;
    return okResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { ...SERVER_INFO },
    });
  }
  if (method === 'notifications/initialized') return okResult(id, {});
  if (method === 'ping') return okResult(id, {});
  if (method === 'tools/list') return okResult(id, { tools: TOOLS });
  if (method === 'tools/call') return handleToolsCall(store, id, value.params);
  return errorResult(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
}

// ---------------------------------------------------------------- HTTP entry point

/**
 * Handle POST /mcp (JSON-RPC 2.0 over Streamable HTTP, answered as
 * application/json). Returns true when the path is /mcp — even when the answer
 * is a 401 or a 400 for it — and false for any other path.
 */
export async function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (pathOf(req) !== '/mcp') return false;
  if (!isAuthorized(store, req)) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: JSON_RPC_UNAUTHORIZED, message: 'Unauthorized' } });
    return true;
  }
  if (req.method === 'DELETE') {
    // End of a legacy session: nothing is held server-side.
    res.writeHead(204);
    res.end();
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: JSON_RPC_METHOD_NOT_FOUND, message: 'Method not allowed: use POST /mcp' } });
    return true;
  }
  const buf = await readBody(req);
  const parsed = parseJson(buf);
  if (!parsed.ok) {
    // A body that is not JSON: HTTP 400 with JSON-RPC -32700 (the modern era's status).
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: JSON_RPC_PARSE_ERROR, message: 'Parse error' } });
    return true;
  }
  const value = parsed.value;
  if (Array.isArray(value)) {
    const answers: Array<Record<string, unknown>> = [];
    for (const item of value) {
      const answer = handleRpc(store, item);
      if (answer !== null) answers.push(answer);
    }
    sendJson(res, 200, answers);
    return true;
  }
  const answer = handleRpc(store, value);
  if (answer === null) {
    // A notification (e.g. notifications/initialized): no response body.
    res.writeHead(202);
    res.end();
    return true;
  }
  sendJson(res, 200, answer);
  return true;
}
