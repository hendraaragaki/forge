// Shared in-memory store for the forge: repos, issues, PRs, labels, contents and the
// git object store + refs. Every surface (git smart HTTP, REST v3, GraphQL v4, MCP)
// reads and writes this one store, so ids and state are identical across them.
//
// Determinism: no Date.now(), no Math.random(), no ports in stored state. Creation
// order and commit timestamps come from a single sequence counter, so a replay of the
// same operations produces byte-identical state.
//
// Identity: the suite's scenario is built from a FIXED constant seed (wire.ts
// SCENARIO_SEED = 0x6a09e667f3bcc909n), so the token owner's login is always
// "adaiversen" (id 1000), the stranger is "olgabauer" (id 1002), the teammate is
// "quinnkeller" (id 1001) and the org is "faint-meadow-org". Verified by running the
// kit's buildScenario() locally. The bearer token itself is MAKEFUN_SHOP_TOKEN.

import { createHash } from 'node:crypto';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const STRANGER_LOGIN = 'olgabauer';
export const STRANGER_ID = 1002;
export const TEAMMATE_LOGIN = 'quinnkeller';
export const TEAMMATE_ID = 1001;
export const ORG_LOGIN = 'faint-meadow-org';

/** Base epoch for deterministic commit timestamps; each commit adds its sequence. */
export const COMMIT_EPOCH = 1_700_000_000;

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  /** Raw object payload WITHOUT the "<type> <len>\0" header. */
  data: Buffer;
}

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  comments: number;
  /** Shared comment list (numeric ids) — read/written by BOTH REST and GraphQL. */
  __forgeComments?: Array<{ id: number; body: string }>;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string; // branch name (short, e.g. "feature/x")
  base: string; // branch name (short, e.g. "main")
  headSha: string | null;
  baseSha: string | null;
  merged: boolean;
  mergeCommitSha: string | null;
  mergeable: boolean;
  createdSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  labels: Label[];
  issues: Issue[];
  pulls: Pull[];
  /** refname (e.g. "refs/heads/main") -> commit sha (hex). */
  refs: Map<string, string>;
  /** sha (hex) -> object. */
  objects: Map<string, GitObject>;
  nextIssue: number;
  nextPull: number;
  nextLabelId: number;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerName: string;
  committerEmail: string;
  committerTime: number;
  message: string;
}

export interface TreeEntry {
  mode: string; // "100644" file, "40000" dir
  name: string;
  sha: string; // hex
}

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of a (type, payload) pair: sha1("<type> <len>\0" + payload). */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Parse a tree object's payload into entries (sorted as stored). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(off, sp).toString('utf8');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    off = nul + 21;
  }
  return entries;
}

/** Serialize tree entries (must already be in git order: dirs sort as if name + "/"). */
export function buildTreePayload(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Git tree sort order: entries sort by name, directories as name + "/". */
export function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
}

/** Parse a commit object's payload. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  const info: CommitInfo = {
    tree: '', parents: [], authorName: '', authorEmail: '', authorTime: 0,
    committerName: '', committerEmail: '', committerTime: 0, message,
  };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const m = line.slice(7).match(/^(.*) <(.*)> (\d+) ([+-]\d+)$/);
      if (m) { info.authorName = m[1]; info.authorEmail = m[2]; info.authorTime = Number(m[3]); }
    } else if (line.startsWith('committer ')) {
      const m = line.slice(10).match(/^(.*) <(.*)> (\d+) ([+-]\d+)$/);
      if (m) { info.committerName = m[1]; info.committerEmail = m[2]; info.committerTime = Number(m[3]); }
    }
  }
  return info;
}

/** Serialize a commit. */
export function buildCommitPayload(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const p of info.parents) lines.push(`parent ${p}`);
  lines.push(`author ${info.authorName} <${info.authorEmail}> ${info.authorTime} +0000`);
  lines.push(`committer ${info.committerName} <${info.committerEmail}> ${info.committerTime} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export class Store {
  readonly token: string;
  readonly viewer: User = { id: VIEWER_ID, login: VIEWER_LOGIN, name: 'ada iversen', email: `${VIEWER_LOGIN}@example.invalid` };
  readonly stranger: User = { id: STRANGER_ID, login: STRANGER_LOGIN, name: 'olga bauer', email: `${STRANGER_LOGIN}@example.invalid` };
  readonly teammate: User = { id: TEAMMATE_ID, login: TEAMMATE_LOGIN, name: 'quinn keller', email: `${TEAMMATE_LOGIN}@example.invalid` };

  /** Monotonic sequence: creation order + commit timestamps. Never a clock. */
  seq = 0;
  /** Shared numeric comment id counter (REST + GraphQL both use this). */
  nextCommentId = 1;
  private nextRepoId = 10000;
  private nextObjectId = 1;
  private nextUserId = 2000;
  repos = new Map<string, Repo>();

  constructor(token: string) {
    this.token = token;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Non-empty request id for X-GitHub-Request-Id (counter-based, deterministic). */
  requestId(): string {
    return `req-${this.nextSeq()}`;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  // ---- repos ----
  createRepo(owner: string, name: string, description = '', isPrivate = false, defaultBranch = 'main'): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name, owner, fullName: `${owner}/${name}`,
      description, private: isPrivate, defaultBranch,
      createdSeq: this.nextSeq(),
      labels: [], issues: [], pulls: [],
      refs: new Map(), objects: new Map(),
      nextIssue: 1, nextPull: 1, nextLabelId: 1,
    };
    // Seed the six default GitHub labels (name + color), ids in creation order.
    const defaults: Array<[string, string]> = [
      ['bug', 'd73a4a'], ['enhancement', 'a2eeef'], ['documentation', '0075ca'],
      ['question', 'd876e3'], ['good first issue', '7057ff'], ['help wanted', '008672'],
    ];
    for (const [n, c] of defaults) {
      repo.labels.push({ id: repo.nextLabelId++, name: n, color: c, description: '' });
    }
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const r of this.repos.values()) if (r.owner === owner) out.push(r);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  // ---- git objects ----
  hasObject(repo: Repo, sha: string): boolean {
    return repo.objects.has(sha);
  }

  getObject(repo: Repo, sha: string): GitObject | undefined {
    return repo.objects.get(sha);
  }

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const sha = hashObject(type, data);
    if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
    return sha;
  }

  createBlob(repo: Repo, data: Buffer): string {
    return this.putObject(repo, 'blob', data);
  }

  createTree(repo: Repo, entries: TreeEntry[]): string {
    return this.putObject(repo, 'tree', buildTreePayload(sortTreeEntries(entries)));
  }

  /** Create a commit with a deterministic timestamp (epoch + sequence). */
  createCommit(repo: Repo, tree: string, parents: string[], message: string, author?: User): string {
    const who = author ?? this.viewer;
    const t = COMMIT_EPOCH + this.nextSeq();
    const info: CommitInfo = {
      tree, parents,
      authorName: who.name, authorEmail: who.email, authorTime: t,
      committerName: who.name, committerEmail: who.email, committerTime: t,
      message,
    };
    return this.putObject(repo, 'commit', buildCommitPayload(info));
  }

  // ---- refs ----
  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, sha: string): void {
    repo.refs.set(ref, sha);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  /** True when `ancestor` is reachable from `descendant` (or equal) by parent walk. */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (cur === ancestor) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
    return false;
  }

  /** All objects reachable from a set of tips (commits + their trees/blobs). */
  reachableObjects(repo: Repo, tips: string[]): Set<string> {
    const seen = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (seen.has(sha)) continue;
      const obj = repo.objects.get(sha);
      if (!obj) continue;
      seen.add(sha);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        stack.push(c.tree);
        for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.sha);
      }
    }
    return seen;
  }

  // ---- flat file map (path -> {mode, sha}) for a tree ----
  flattenTree(repo: Repo, treeSha: string, prefix = '', out = new Map<string, { mode: string; sha: string }>()): Map<string, { mode: string; sha: string }> {
    const obj = repo.objects.get(treeSha);
    if (!obj || obj.type !== 'tree') return out;
    for (const e of parseTree(obj.data)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') this.flattenTree(repo, e.sha, path, out);
      else out.set(path, { mode: e.mode, sha: e.sha });
    }
    return out;
  }

  /** Rebuild nested trees from a flat path map; returns the root tree sha. */
  buildTreeFromMap(repo: Repo, files: Map<string, { mode: string; sha: string }>): string {
    const buildPrefix = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const subdirs = new Set<string>();
      for (const [path, v] of files) {
        if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash < 0) entries.push({ mode: v.mode, name: rest, sha: v.sha });
        else subdirs.add(rest.slice(0, slash));
      }
      for (const sub of subdirs) {
        const subPrefix = prefix === '' ? sub : `${prefix}/${sub}`;
        entries.push({ mode: '40000', name: sub, sha: buildPrefix(subPrefix) });
      }
      return this.createTree(repo, entries);
    };
    return buildPrefix('');
  }

  // ---- contents (file at HEAD of default branch) ----
  headCommit(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  readFileAtHead(repo: Repo, path: string): { sha: string; content: Buffer } | null {
    const head = this.headCommit(repo);
    if (!head) return null;
    const commit = repo.objects.get(head);
    if (!commit || commit.type !== 'commit') return null;
    const tree = parseCommit(commit.data).tree;
    const flat = this.flattenTree(repo, tree);
    const entry = flat.get(path);
    if (!entry) return null;
    const blob = repo.objects.get(entry.sha);
    if (!blob) return null;
    return { sha: entry.sha, content: blob.data };
  }

  /**
   * Write (create/update) a file on the default branch, creating a commit.
   * Returns the new commit sha. When `expectedSha` is given and the file's current
   * blob sha differs, returns null (stale sha -> 409).
   */
  writeFile(repo: Repo, path: string, content: Buffer, message: string, expectedSha?: string): string | null {
    const head = this.headCommit(repo);
    const flat = head ? this.flattenTree(repo, parseCommit(repo.objects.get(head)!.data).tree) : new Map<string, { mode: string; sha: string }>();
    const current = flat.get(path);
    if (expectedSha !== undefined) {
      if (!current || current.sha !== expectedSha) return null;
    }
    const blobSha = this.createBlob(repo, content);
    flat.set(path, { mode: '100644', sha: blobSha });
    const treeSha = this.buildTreeFromMap(repo, flat);
    const parents = head ? [head] : [];
    const commitSha = this.createCommit(repo, treeSha, parents, message);
    this.setRef(repo, `refs/heads/${repo.defaultBranch}`, commitSha);
    return commitSha;
  }

  /** Delete a file on the default branch, creating a commit. Null when absent. */
  deleteFile(repo: Repo, path: string, message: string): string | null {
    const head = this.headCommit(repo);
    if (!head) return null;
    const flat = this.flattenTree(repo, parseCommit(repo.objects.get(head)!.data).tree);
    if (!flat.has(path)) return null;
    flat.delete(path);
    const treeSha = this.buildTreeFromMap(repo, flat);
    const commitSha = this.createCommit(repo, treeSha, [head], message);
    this.setRef(repo, `refs/heads/${repo.defaultBranch}`, commitSha);
    return commitSha;
  }

  // ---- labels / issues / pulls ----
  createLabel(repo: Repo, name: string, color = 'ededed', description = ''): Label {
    const label: Label = { id: repo.nextLabelId++, name, color, description };
    repo.labels.push(label);
    return label;
  }

  findLabel(repo: Repo, name: string): Label | undefined {
    return repo.labels.find((l) => l.name === name);
  }

  createIssue(repo: Repo, title: string, body = '', labels: string[] = []): Issue {
    const issue: Issue = {
      id: 10000 + this.nextObjectId++,
      number: repo.nextIssue++, title, body, state: 'open',
      labels: [...labels], createdSeq: this.nextSeq(), comments: 0,
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((i) => i.number === number);
  }

  /** The shared comment list for an issue (created on demand). REST + GraphQL. */
  getIssueComments(issue: Issue): Array<{ id: number; body: string }> {
    if (!Array.isArray(issue.__forgeComments)) issue.__forgeComments = [];
    return issue.__forgeComments;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull {
    const headRef = repo.refs.get(`refs/heads/${head}`) ?? null;
    const baseRef = repo.refs.get(`refs/heads/${base}`) ?? null;
    const pull: Pull = {
      id: 20000 + this.nextObjectId++,
      number: repo.nextPull++, title, body, state: 'open',
      head, base, headSha: headRef, baseSha: baseRef,
      merged: false, mergeCommitSha: null, mergeable: true,
      createdSeq: this.nextSeq(),
    };
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((p) => p.number === number);
  }

  /**
   * Squash-merge a pull: one commit on the default branch whose tree is the head
   * branch's tree, parented on the base head. Returns the merge commit sha, or
   * null when the pull cannot merge (unknown head/base).
   */
  mergePull(repo: Repo, pull: Pull, message?: string): string | null {
    const baseHead = repo.refs.get(`refs/heads/${pull.base}`);
    const headHead = repo.refs.get(`refs/heads/${pull.head}`);
    if (!baseHead || !headHead) return null;
    const headCommit = repo.objects.get(headHead);
    if (!headCommit || headCommit.type !== 'commit') return null;
    const tree = parseCommit(headCommit.data).tree;
    const msg = message ?? `Merge pull request #${pull.number} (${pull.title})`;
    const mergeSha = this.createCommit(repo, tree, [baseHead], msg);
    this.setRef(repo, `refs/heads/${pull.base}`, mergeSha);
    // The default branch moved; if base is the default branch, HEAD follows.
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = mergeSha;
    return mergeSha;
  }

  /** Next fresh id for a GraphQL node (deterministic counter). */
  nextNodeId(base: number): number {
    return base + this.nextObjectId++;
  }
}
