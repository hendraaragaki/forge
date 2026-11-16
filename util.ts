// Shared HTTP helpers + GitHub REST v3 serializers. Used by every surface.
// All replies are JSON (never HTML); every REST reply carries a non-empty
// X-GitHub-Request-Id. Auth is Bearer <MAKEFUN_SHOP_TOKEN>; missing/wrong = 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN, type Issue, type Label, type Pull, type Repo, type User } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** Read the full request body (cap 16 MiB; larger -> null). */
export async function readBody(req: IncomingMessage, maxBytes = 16 * 1024 * 1024): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Parse a JSON body; returns { ok: true, value } or { ok: false, error }. */
export function parseJson(buf: Buffer | null): { ok: true; value: unknown } | { ok: false; error: string } {
  if (buf === null) return { ok: false, error: 'body too large' };
  if (buf.length === 0) return { ok: false, error: 'empty body' };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false, error: 'malformed JSON' };
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

export function sendRaw(res: ServerResponse, status: number, buf: Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': buf.length, ...headers });
  res.end(buf);
}

/** Bearer token from the Authorization header, or null. */
export function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/.exec(h);
  return m ? m[1] : null;
}

/** True when the request carries the suite's token. */
export function isAuthorized(store: Store, req: IncomingMessage): boolean {
  const t = bearerToken(req);
  return t !== null && store.token !== '' && t === store.token;
}

/** The path of a request URL (no query), or '/' when it does not parse. */
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** X-GitHub-Request-Id header value (fresh, non-empty). */
export function requestIdHeader(store: Store): Record<string, string> {
  return { 'x-github-request-id': store.requestId() };
}

/** Build a GitHub-style Link header for pagination. */
export function linkHeader(base: string, page: number, perPage: number, total: number): string {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const parts: string[] = [];
  if (page < lastPage) parts.push(`<${base}?page=${page + 1}&per_page=${perPage}>; rel="next"`);
  if (lastPage > 1) parts.push(`<${base}?page=${lastPage}&per_page=${perPage}>; rel="last"`);
  if (page > 1) {
    parts.push(`<${base}?page=1&per_page=${perPage}>; rel="first"`);
    parts.push(`<${base}?page=${page - 1}&per_page=${perPage}>; rel="prev"`);
  }
  return parts.join(', ');
}

/** Parse ?page=&per_page= (GitHub defaults: page 1, per_page 30). */
export function pagination(q: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(q.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(q.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

export function paginate<T>(items: T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

// ---- GitHub REST v3 serializers (standard shapes; checks read subsets) ----

export function userJson(u: User): Record<string, unknown> {
  return {
    login: u.login, id: u.id, node_id: `MDQ6VXNlcj${u.id}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${u.id}?v=4`,
    gravatar_id: '', url: `/api/v3/users/${u.login}`, html_url: `https://github.com/${u.login}`,
    type: 'User', site_admin: false, name: u.name, email: u.email,
  };
}

export function repoJson(store: Store, r: Repo): Record<string, unknown> {
  return {
    id: r.id, node_id: `MDEwOlJlcG9zaXRvcnk${r.id}`,
    name: r.name, full_name: r.fullName, private: r.private,
    owner: userJson({ id: r.owner === VIEWER_LOGIN ? store.viewer.id : 0, login: r.owner, name: r.owner, email: `${r.owner}@example.invalid` }),
    html_url: `https://github.com/${r.fullName}`,
    description: r.description, fork: false,
    url: `/api/v3/repos/${r.fullName}`,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', pushed_at: '2026-01-01T00:00:00Z',
    homepage: null, size: 0, stargazers_count: 0, watchers_count: 0, language: null,
    has_issues: true, has_projects: true, has_downloads: true, has_wiki: true, has_pages: false,
    has_discussions: false, forks_count: 0, open_issues_count: r.issues.filter((i) => i.state === 'open').length,
    license: null, allow_forking: true, is_template: false, topics: [],
    visibility: r.private ? 'private' : 'public', forks: 0, open_issues: r.issues.filter((i) => i.state === 'open').length,
    watchers: 0, default_branch: r.defaultBranch,
  };
}

export function labelJson(l: Label): Record<string, unknown> {
  return {
    id: l.id, node_id: `MDU6TGFiZWw${l.id}`, url: '',
    name: l.name, color: l.color, default: false, description: l.description,
  };
}

export function issueJson(store: Store, repo: Repo, i: Issue): Record<string, unknown> {
  return {
    id: i.id, node_id: `MDU6SXNzdWU${i.id}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${i.number}`,
    repository_url: `/api/v3/repos/${repo.fullName}`,
    labels_url: `/api/v3/repos/${repo.fullName}/issues/${i.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.fullName}/issues/${i.number}/comments`,
    html_url: `https://github.com/${repo.fullName}/issues/${i.number}`,
    number: i.number, title: i.title, body: i.body,
    user: userJson(store.viewer),
    labels: i.labels.map((n) => {
      const l = repo.labels.find((x) => x.name === n);
      return l ? labelJson(l) : { name: n, color: 'ededed', description: '' };
    }),
    state: i.state, locked: false, assignee: null, assignees: [], milestone: null,
    comments: i.comments,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', closed_at: i.state === 'closed' ? '2026-01-01T00:00:00Z' : null,
    author_association: 'OWNER', active_lock_reason: null,
  };
}

export function pullJson(store: Store, repo: Repo, p: Pull): Record<string, unknown> {
  const headSha = p.headSha ?? repo.refs.get(`refs/heads/${p.head}`) ?? null;
  const baseSha = p.baseSha ?? repo.refs.get(`refs/heads/${p.base}`) ?? null;
  return {
    id: p.id, node_id: `MDExOlB1bGxSZXF1ZXN0${p.id}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${p.number}`,
    html_url: `https://github.com/${repo.fullName}/pull/${p.number}`,
    number: p.number, title: p.title, body: p.body, state: p.state,
    locked: false, draft: false,
    user: userJson(store.viewer),
    head: { label: `${repo.owner}:${p.head}`, ref: p.head, sha: headSha, user: userJson(store.viewer), repo: repoJson(store, repo) },
    base: { label: `${repo.owner}:${p.base}`, ref: p.base, sha: baseSha, user: userJson(store.viewer), repo: repoJson(store, repo) },
    merged: p.merged, mergeable: p.mergeable, mergeable_state: p.mergeable ? 'clean' : 'dirty',
    merged_at: p.merged ? '2026-01-01T00:00:00Z' : null,
    merge_commit_sha: p.mergeCommitSha,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', closed_at: p.state === 'closed' ? '2026-01-01T00:00:00Z' : null,
    author_association: 'OWNER', auto_merge: null, active_lock_reason: null,
  };
}

/** A commit object as the contents API returns it ({sha, commit:{message,...}}). */
export function commitRefJson(sha: string, message: string): Record<string, unknown> {
  return { sha, commit: { message }, author: null, committer: null, parents: [] };
}
