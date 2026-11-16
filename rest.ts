// REST v3 surface for the forge: /api/v3.
// Node 22 stdlib only. All state goes through the shared Store; issue comments live in a
// small module-level map keyed by repo+issue (deterministic ids from a counter, in request
// order, so a replay of the same requests yields identical ids).
// Every reply is JSON with a non-empty X-GitHub-Request-Id; errors are {message}.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN, parseCommit, parseTree, type Issue, type Pull, type Repo } from './store.ts';
import {
  bearerToken,
  commitRefJson,
  issueJson,
  isAuthorized,
  labelJson,
  linkHeader,
  paginate,
  pagination,
  parseJson,
  pathOf,
  pullJson,
  queryOf,
  readBody,
  repoJson,
  requestIdHeader,
  sendJson,
  userJson,
} from './util.ts';

type Json = Record<string, unknown>;

function segments(path: string): string[] {
  return path
    .split('/')
    .filter((s) => s !== '')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

function reply(store: Store, res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  sendJson(res, status, body, { ...requestIdHeader(store), ...extra });
}

function err(store: Store, res: ServerResponse, status: number, message: string): void {
  reply(store, res, status, { message });
}

function absoluteBase(req: IncomingMessage, path: string): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}${path}`;
}

function linkFor(req: IncomingMessage, path: string, page: number, perPage: number, total: number): Record<string, string> {
  const link = linkHeader(absoluteBase(req, path), page, perPage, total);
  return link === '' ? {} : { link };
}

async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: Json } | { ok: false }> {
  const buf = await readBody(req);
  if (buf === null) return { ok: false };
  if (buf.length === 0) return { ok: true, value: {} };
  const parsed = parseJson(buf);
  if (!parsed.ok) return { ok: false };
  const value = parsed.value;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return { ok: true, value: value as Json };
  return { ok: true, value: {} };
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function labelNames(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string') out.push(item);
    else if (typeof item === 'object' && item !== null && typeof (item as Json).name === 'string') out.push((item as Json).name as string);
  }
  return out;
}

/** A repo only when the owner is the token's login; anything else is 404, never 403. */
function resolveRepo(store: Store, owner: string, name: string): Repo | undefined {
  if (owner !== store.viewer.login) return undefined;
  return store.getRepo(owner, name);
}

/** Resolve a ref (?ref= branch name, or a commit sha) to its commit sha. */
function commitForRef(repo: Repo, ref?: string): string | undefined {
  if (ref === undefined || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const asBranch = repo.refs.get(`refs/heads/${ref}`);
  if (asBranch !== undefined) return asBranch;
  if (repo.objects.has(ref)) return ref;
  return undefined;
}

function treeShaOfCommit(repo: Repo, commitSha: string): string | undefined {
  const obj = repo.objects.get(commitSha);
  if (!obj || obj.type !== 'commit') return undefined;
  return parseCommit(obj.data).tree;
}

/** Flat path -> {mode, sha} map for a commit, or null when the commit is unknown. */
function flatAtCommit(store: Store, repo: Repo, commitSha: string): Map<string, { mode: string; sha: string }> | null {
  const tree = treeShaOfCommit(repo, commitSha);
  if (tree === undefined) return null;
  return store.flattenTree(repo, tree);
}

/** Navigate a tree to a directory path; returns the tree sha or null. */
function treeAtPath(repo: Repo, rootTree: string, dirPath: string): string | null {
  if (dirPath === '' || dirPath === '/') return rootTree;
  let cur = rootTree;
  for (const part of dirPath.split('/').filter((p) => p !== '')) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    if (!entry) return null;
    cur = entry.sha;
  }
  return cur;
}

function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

function lineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** Line multiset diff: [additions, deletions]. */
function lineDiff(oldText: string, newText: string): [number, number] {
  const counts = new Map<string, number>();
  for (const line of oldText.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newText.split('\n')) {
    const c = counts.get(line) ?? 0;
    if (c > 0) counts.set(line, c - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const c of counts.values()) deletions += c;
  // Trailing empty line from a final newline is not a real line on either side.
  if (oldText.endsWith('\n')) deletions = Math.max(0, deletions - 1);
  if (newText.endsWith('\n')) additions = Math.max(0, additions - 1);
  return [additions, deletions];
}

interface FileChange {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

function pullFiles(store: Store, repo: Repo, pull: Pull): FileChange[] {
  const baseSha = pull.baseSha ?? repo.refs.get(`refs/heads/${pull.base}`);
  const headSha = pull.headSha ?? repo.refs.get(`refs/heads/${pull.head}`);
  if (baseSha === undefined || headSha === undefined) return [];
  const baseFlat = flatAtCommit(store, repo, baseSha);
  const headFlat = flatAtCommit(store, repo, headSha);
  if (baseFlat === null || headFlat === null) return [];
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    if (b !== undefined && h !== undefined && b.sha === h.sha) continue;
    if (b === undefined && h !== undefined) {
      const blob = repo.objects.get(h.sha);
      const additions = blob ? lineCount(blob.data.toString('utf8')) : 0;
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b !== undefined && h === undefined) {
      const blob = repo.objects.get(b.sha);
      const deletions = blob ? lineCount(blob.data.toString('utf8')) : 0;
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b !== undefined && h !== undefined) {
      const oldBlob = repo.objects.get(b.sha);
      const newBlob = repo.objects.get(h.sha);
      const [additions, deletions] = lineDiff(
        oldBlob ? oldBlob.data.toString('utf8') : '',
        newBlob ? newBlob.data.toString('utf8') : '',
      );
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** Write a file on a named branch (default branch when omitted). Null on stale sha. */
function writeFileOnBranch(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
  expectedSha?: string,
): { commitSha: string; contentSha: string; existed: boolean } | null {
  const head = repo.refs.get(`refs/heads/${branch}`);
  const flat = head ? store.flattenTree(repo, parseCommit(repo.objects.get(head)!.data).tree) : new Map<string, { mode: string; sha: string }>();
  const current = flat.get(path);
  if (expectedSha !== undefined && (!current || current.sha !== expectedSha)) return null;
  const existed = current !== undefined;
  const blobSha = store.createBlob(repo, content);
  flat.set(path, { mode: '100644', sha: blobSha });
  const treeSha = store.buildTreeFromMap(repo, flat);
  const commitSha = store.createCommit(repo, treeSha, head ? [head] : [], message);
  store.setRef(repo, `refs/heads/${branch}`, commitSha);
  return { commitSha, contentSha: blobSha, existed };
}

function deleteFileOnBranch(store: Store, repo: Repo, branch: string, path: string, message: string): string | null {
  const head = repo.refs.get(`refs/heads/${branch}`);
  if (!head) return null;
  const flat = store.flattenTree(repo, parseCommit(repo.objects.get(head)!.data).tree);
  if (!flat.has(path)) return null;
  flat.delete(path);
  const treeSha = store.buildTreeFromMap(repo, flat);
  const commitSha = store.createCommit(repo, treeSha, [head], message);
  store.setRef(repo, `refs/heads/${branch}`, commitSha);
  return commitSha;
}

/** True when the head branch changed a file the base also changed (differently) since baseSha. */
function isConflicted(store: Store, repo: Repo, pull: Pull): boolean {
  const baseSha0 = pull.baseSha;
  const headHead = repo.refs.get(`refs/heads/${pull.head}`);
  const baseHead = repo.refs.get(`refs/heads/${pull.base}`);
  if (baseSha0 === null || baseSha0 === undefined || headHead === undefined || baseHead === undefined) return true;
  const base0Flat = flatAtCommit(store, repo, baseSha0);
  const headFlat = flatAtCommit(store, repo, headHead);
  const baseFlat = flatAtCommit(store, repo, baseHead);
  if (base0Flat === null || headFlat === null || baseFlat === null) return true;
  const paths = new Set<string>([...base0Flat.keys(), ...headFlat.keys(), ...baseFlat.keys()]);
  for (const path of paths) {
    const o = base0Flat.get(path)?.sha;
    const h = headFlat.get(path)?.sha;
    const b = baseFlat.get(path)?.sha;
    const headChanged = h !== o;
    const baseChanged = b !== o;
    if (headChanged && baseChanged && h !== b) return true;
  }
  return false;
}

// ---- issue comments (shared with GraphQL via store.getIssueComments) ----

function commentJson(store: Store, repo: Repo, issue: Issue, c: { id: number; body: string }): Record<string, unknown> {
  return {
    id: c.id,
    node_id: `MDEyOklzc3VlQ29tbWVud${c.id}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments/${c.id}`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-${c.id}`,
    body: c.body,
    user: userJson(store.viewer),
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

export async function handleRest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = pathOf(req);
  if (path !== '/api/v3' && !path.startsWith('/api/v3/')) return false;
  const method = (req.method ?? 'GET').toUpperCase();
  const seg = segments(path);
  // seg[0]='api', seg[1]='v3', rest follows.
  const rest = seg.slice(2);
  const q = queryOf(req);

  // Auth first for every /api/v3 route: no token or wrong token is 401 JSON.
  if (!isAuthorized(store, req)) {
    err(store, res, 401, 'Requires authentication');
    return true;
  }

  const needsBody = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
  let body: Json = {};
  if (needsBody) {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
      err(store, res, 400, 'malformed JSON');
      return true;
    }
    body = parsed.value;
  }

  const notFound = (msg = 'Not Found'): void => err(store, res, 404, msg);

  // ---- root & meta ----
  if (rest.length === 0) {
    if (method !== 'GET') { notFound(); return true; }
    reply(store, res, 200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://github.com/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
      commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
      emails_url: '/api/v3/user/emails',
      emojis_url: '/api/v3/emojis',
      events_url: '/api/v3/events',
      feeds_url: '/api/v3/feeds',
      followers_url: '/api/v3/user/followers',
      following_url: '/api/v3/user/following{/target}',
      gists_url: '/api/v3/gists{/gist_id}',
      hub_url: 'https://api.github.com/hub',
      issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
      issues_url: '/api/v3/issues',
      keys_url: '/api/v3/user/keys',
      label_search_url: '/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}',
      notifications_url: '/api/v3/notifications',
      organization_url: '/api/v3/orgs/{org}',
      organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
      organization_teams_url: '/api/v3/orgs/{org}/teams',
      public_gists_url: '/api/v3/gists/public',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
      current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      starred_url: '/api/v3/user/starred{/owner}{/repo}',
      starred_gists_url: '/api/v3/gists/starred',
      topic_search_url: '/api/v3/search/topics?q={query}{&page,per_page}',
      user_url: '/api/v3/users/{user}',
      user_organizations_url: '/api/v3/user/orgs',
      user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
    }, { 'x-oauth-scopes': 'repo, user' });
    return true;
  }

  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') { notFound(); return true; }
    reply(store, res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0' });
    return true;
  }

  // ---- /user ----
  if (rest[0] === 'user') {
    if (rest.length === 1) {
      if (method !== 'GET') { notFound(); return true; }
      reply(store, res, 200, userJson(store.viewer));
      return true;
    }
    if (rest.length === 2 && rest[1] === 'repos') {
      if (method === 'GET') {
        const { page, perPage } = pagination(q);
        const all = store.listReposByOwner(store.viewer.login);
        const pageItems = paginate(all, page, perPage);
        reply(store, res, 200, pageItems.map((r) => repoJson(store, r)), linkFor(req, path, page, perPage, all.length));
        return true;
      }
      if (method === 'POST') {
        const name = str(body.name);
        if (name === '') { err(store, res, 422, 'name is required'); return true; }
        if (store.getRepo(store.viewer.login, name) !== undefined) { err(store, res, 422, 'Repository already exists'); return true; }
        const repo = store.createRepo(
          store.viewer.login,
          name,
          str(body.description),
          body.private === true,
          str(body.default_branch, 'main') || 'main',
        );
        reply(store, res, 201, repoJson(store, repo));
        return true;
      }
      notFound();
      return true;
    }
    notFound();
    return true;
  }

  // ---- /repos/{owner}/{repo}[...] ----
  if (rest[0] === 'repos') {
    if (rest.length < 3) { notFound(); return true; }
    const owner = rest[1] as string;
    const repoName = rest[2] as string;
    const repo = resolveRepo(store, owner, repoName);
    if (repo === undefined) { notFound('Not Found'); return true; }
    const tail = rest.slice(3);

    // /repos/{o}/{r} itself
    if (tail.length === 0) {
      if (method === 'GET') { reply(store, res, 200, repoJson(store, repo)); return true; }
      if (method === 'PATCH') {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        reply(store, res, 200, repoJson(store, repo));
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        res.writeHead(204, { ...requestIdHeader(store) });
        res.end();
        return true;
      }
      notFound();
      return true;
    }

    const sub = tail[0] as string;

    // ---- git/refs (branch create) ----
    if (sub === 'git' && tail[1] === 'refs' && tail.length === 2) {
      if (method !== 'POST') { notFound(); return true; }
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (ref === '' || sha === '') { err(store, res, 422, 'ref and sha are required'); return true; }
      store.setRef(repo, ref, sha);
      reply(store, res, 201, { ref, node_id: `MDM6UmVm${repo.id}`, url: `/api/v3/repos/${repo.fullName}/git/refs/${encodeURIComponent(ref)}`, object: { sha, type: 'commit', url: `/api/v3/repos/${repo.fullName}/git/commits/${sha}` } });
      return true;
    }

    // ---- branches ----
    if (sub === 'branches' && tail.length === 1) {
      if (method !== 'GET') { notFound(); return true; }
      const out: Array<Record<string, unknown>> = [];
      for (const [ref, sha] of repo.refs) {
        if (!ref.startsWith('refs/heads/')) continue;
        out.push({ name: ref.slice('refs/heads/'.length), commit: { sha, url: `/api/v3/repos/${repo.fullName}/commits/${sha}` }, protected: false });
      }
      reply(store, res, 200, out);
      return true;
    }

    // ---- commits ----
    if (sub === 'commits' && tail.length === 1) {
      if (method !== 'GET') { notFound(); return true; }
      const shaParam = q.get('sha') ?? undefined;
      const tip = commitForRef(repo, shaParam);
      if (tip === undefined) { notFound('No commit found for the given ref'); return true; }
      const seen = new Set<string>();
      const ordered: string[] = [];
      const stack = [tip];
      while (stack.length > 0) {
        const cur = stack.pop() as string;
        if (seen.has(cur)) continue;
        const obj = repo.objects.get(cur);
        if (!obj || obj.type !== 'commit') continue;
        seen.add(cur);
        ordered.push(cur);
        const parents = parseCommit(obj.data).parents;
        for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
      }
      reply(store, res, 200, ordered.map((sha) => {
        const info = parseCommit(repo.objects.get(sha)!.data);
        return {
          sha,
          node_id: `MDY6Q29tbWl0${sha.slice(0, 8)}`,
          commit: { message: info.message, author: { name: info.authorName, email: info.authorEmail }, committer: { name: info.committerName, email: info.committerEmail }, tree: { sha: info.tree } },
          author: null, committer: null, parents: info.parents.map((p) => ({ sha: p })),
          url: `/api/v3/repos/${repo.fullName}/commits/${sha}`,
          html_url: `https://github.com/${repo.fullName}/commit/${sha}`,
        };
      }));
      return true;
    }

    // ---- contents ----
    if (sub === 'contents') {
      const filePath = tail.slice(1).join('/');
      const ref = q.get('ref') ?? undefined;
      const branch = typeof body.branch === 'string' && body.branch !== '' ? (body.branch as string) : repo.defaultBranch;
      if (method === 'GET') {
        const tip = commitForRef(repo, ref);
        if (tip === undefined) { notFound('Not Found'); return true; }
        const flat = flatAtCommit(store, repo, tip);
        if (flat === null) { notFound('Not Found'); return true; }
        const entry = filePath === '' ? undefined : flat.get(filePath);
        if (entry !== undefined) {
          const blob = repo.objects.get(entry.sha);
          const content = blob ? blob.data : Buffer.alloc(0);
          reply(store, res, 200, {
            type: 'file', encoding: 'base64', size: content.length, name: baseName(filePath), path: filePath,
            content: content.toString('base64'), sha: entry.sha,
            url: `/api/v3/repos/${repo.fullName}/contents/${filePath}`,
            html_url: `https://github.com/${repo.fullName}/blob/${repo.defaultBranch}/${filePath}`,
            git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${entry.sha}`,
            download_url: null, _links: {},
          });
          return true;
        }
        // Directory listing (root when filePath is empty).
        const rootTree = treeShaOfCommit(repo, tip);
        if (rootTree === undefined) { notFound('Not Found'); return true; }
        const dirTree = treeAtPath(repo, rootTree, filePath);
        if (dirTree === null) { notFound('Not Found'); return true; }
        const dirObj = repo.objects.get(dirTree);
        if (!dirObj || dirObj.type !== 'tree') { notFound('Not Found'); return true; }
        const out = parseTree(dirObj.data).map((e) => {
          const childPath = filePath === '' ? e.name : `${filePath}/${e.name}`;
          let size = 0;
          if (e.mode !== '40000') {
            const blob = repo.objects.get(e.sha);
            size = blob ? blob.data.length : 0;
          }
          return {
            type: e.mode === '40000' ? 'dir' : 'file', size, name: e.name, path: childPath, sha: e.sha,
            url: `/api/v3/repos/${repo.fullName}/contents/${childPath}`,
            html_url: `https://github.com/${repo.fullName}/tree/${repo.defaultBranch}/${childPath}`,
            git_url: `/api/v3/repos/${repo.fullName}/git/trees/${e.sha}`,
            download_url: null, _links: {},
          };
        });
        reply(store, res, 200, out);
        return true;
      }
      if (method === 'PUT') {
        if (filePath === '') { err(store, res, 422, 'path is required'); return true; }
        const contentB64 = str(body.content);
        const content = contentB64 === '' ? Buffer.alloc(0) : Buffer.from(contentB64, 'base64');
        const message = str(body.message, 'Update file');
        const sha = typeof body.sha === 'string' ? (body.sha as string) : undefined;
        const written = writeFileOnBranch(store, repo, branch, filePath, content, message, sha);
        if (written === null) { err(store, res, 409, 'sha does not match the current file'); return true; }
        reply(store, res, written.existed ? 200 : 201, {
          content: {
            type: 'file', encoding: 'base64', size: content.length, name: baseName(filePath), path: filePath,
            content: content.toString('base64'), sha: written.contentSha,
            url: `/api/v3/repos/${repo.fullName}/contents/${filePath}`,
          },
          commit: commitRefJson(written.commitSha, message),
        });
        return true;
      }
      if (method === 'DELETE') {
        if (filePath === '') { err(store, res, 422, 'path is required'); return true; }
        const message = str(body.message, 'Delete file');
        const commitSha = deleteFileOnBranch(store, repo, branch, filePath, message);
        if (commitSha === null) { notFound('Not Found'); return true; }
        reply(store, res, 200, { commit: commitRefJson(commitSha, message) });
        return true;
      }
      notFound();
      return true;
    }

    // ---- labels ----
    if (sub === 'labels' && tail.length === 1) {
      if (method === 'GET') { reply(store, res, 200, repo.labels.map((l) => labelJson(l))); return true; }
      if (method === 'POST') {
        const name = str(body.name);
        if (name === '') { err(store, res, 422, 'name is required'); return true; }
        const existing = store.findLabel(repo, name);
        if (existing !== undefined) { reply(store, res, 201, labelJson(existing)); return true; }
        const label = store.createLabel(repo, name, str(body.color, 'ededed'), str(body.description));
        reply(store, res, 201, labelJson(label));
        return true;
      }
      notFound();
      return true;
    }

    // ---- issues ----
    if (sub === 'issues') {
      // /issues list & create
      if (tail.length === 1) {
        if (method === 'GET') {
          const { page, perPage } = pagination(q);
          const state = q.get('state') ?? 'open';
          const sort = q.get('sort') ?? 'created';
          const direction = q.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state === 'open') list = list.filter((i) => i.state === 'open');
          else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
          if (sort === 'created') {
            list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          }
          const total = list.length;
          const pageItems = paginate(list, page, perPage);
          reply(store, res, 200, pageItems.map((i) => issueJson(store, repo, i)), linkFor(req, path, page, perPage, total));
          return true;
        }
        if (method === 'POST') {
          const title = str(body.title);
          const names = labelNames(body.labels);
          for (const n of names) {
            if (store.findLabel(repo, n) === undefined) { err(store, res, 422, `Label does not exist: ${n}`); return true; }
          }
          const issue = store.createIssue(repo, title, str(body.body), names);
          reply(store, res, 201, issueJson(store, repo, issue));
          return true;
        }
        notFound();
        return true;
      }
      // /issues/{number}...
      const num = Number.parseInt(tail[1] as string, 10);
      if (!Number.isInteger(num)) { notFound(); return true; }
      const issue = store.getIssue(repo, num);
      if (issue === undefined) { notFound('Not Found'); return true; }
      if (tail.length === 2) {
        if (method === 'GET') { reply(store, res, 200, issueJson(store, repo, issue)); return true; }
        if (method === 'PATCH') {
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state as 'open' | 'closed';
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.labels !== undefined) {
            const names = labelNames(body.labels);
            for (const n of names) {
              if (store.findLabel(repo, n) === undefined) { err(store, res, 422, `Label does not exist: ${n}`); return true; }
            }
            issue.labels = names;
          }
          reply(store, res, 200, issueJson(store, repo, issue));
          return true;
        }
        notFound();
        return true;
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        const list = store.getIssueComments(issue);
        if (method === 'POST') {
          const text = str(body.body);
          const c = { id: store.nextCommentId++, body: text };
          list.push(c);
          issue.comments = list.length;
          reply(store, res, 201, commentJson(store, repo, issue, c));
          return true;
        }
        if (method === 'GET') {
          reply(store, res, 200, list.map((c) => commentJson(store, repo, issue, c)));
          return true;
        }
        notFound();
        return true;
      }
      notFound();
      return true;
    }

    // ---- pulls ----
    if (sub === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const { page, perPage } = pagination(q);
          const state = q.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state === 'open') list = list.filter((p) => p.state === 'open');
          else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
          list.sort((a, b) => b.createdSeq - a.createdSeq);
          const total = list.length;
          const pageItems = paginate(list, page, perPage);
          reply(store, res, 200, pageItems.map((p) => pullJson(store, repo, p)), linkFor(req, path, page, perPage, total));
          return true;
        }
        if (method === 'POST') {
          const headRaw = str(body.head);
          const baseRaw = str(body.base);
          const head = headRaw.includes(':') ? (headRaw.split(':').slice(1).join(':') as string) : headRaw;
          const base = baseRaw.includes(':') ? (baseRaw.split(':').slice(1).join(':') as string) : baseRaw;
          if (head === '' || base === '') { err(store, res, 422, 'head and base are required'); return true; }
          const pull = store.createPull(repo, str(body.title), str(body.body), head, base);
          reply(store, res, 201, pullJson(store, repo, pull));
          return true;
        }
        notFound();
        return true;
      }
      const num = Number.parseInt(tail[1] as string, 10);
      if (!Number.isInteger(num)) { notFound(); return true; }
      const pull = store.getPull(repo, num);
      if (tail.length === 2) {
        if (pull === undefined) { notFound('Not Found'); return true; }
        if (method === 'GET') { reply(store, res, 200, pullJson(store, repo, pull)); return true; }
        notFound();
        return true;
      }
      if (tail.length === 3 && tail[2] === 'files') {
        if (pull === undefined) { notFound('Not Found'); return true; }
        if (method !== 'GET') { notFound(); return true; }
        reply(store, res, 200, pullFiles(store, repo, pull).map((f) => ({
          sha: '', filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes,
          blob_url: '', raw_url: '', contents_url: '',
        })));
        return true;
      }
      if (tail.length === 3 && tail[2] === 'merge') {
        if (pull === undefined) { notFound('Not Found'); return true; }
        if (method !== 'PUT') { notFound(); return true; }
        if (pull.merged || pull.state === 'closed') { err(store, res, 405, 'Pull request has already been merged or closed'); return true; }
        if (isConflicted(store, repo, pull)) { err(store, res, 405, 'Merge conflict'); return true; }
        const mergeSha = store.mergePull(repo, pull);
        if (mergeSha === null) { err(store, res, 405, 'Merge conflict'); return true; }
        reply(store, res, 200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
        return true;
      }
      notFound();
      return true;
    }

    notFound();
    return true;
  }

  // Any other /api/v3 route: JSON 404.
  notFound();
  return true;
}
