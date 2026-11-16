// GraphQL v4 surface (POST /api/graphql) for the forge.
//
// A small, purpose-built executor (lexer + parser + validator + resolver) for the
// documents gh and github-mcp-server actually send (see
// program/env/src/graphql-client.ts and checks-graphql.ts). It is NOT a general
// GraphQL implementation: it covers the operations, arguments, variables, aliases
// and fragments those documents use, plus __schema/__type introspection.
//
// Shared state: everything reads/writes the Store (store.ts) only, so a PR or
// issue created here reads back identically over REST, and vice versa.
//
// Global (Relay) ids are opaque, stable strings, never the bare numeric id:
//   Repository  "R_<databaseId>"          e.g. "R_10000"
//   Issue       "I_<repoDbId>_<number>"   e.g. "I_10000_3"
//   PullRequest "PR_<repoDbId>_<number>"  e.g. "PR_10000_1"
//   Comment     "C_<repoDbId>_<issue>_<n>" (n = 1-based comment index on the issue)
//
// Cross-surface convention for comments (read this if you own REST):
//   store.ts has no comment list, only Issue.comments (a count). Comments are stored
//   on the Issue object itself via store.getIssueComments(issue), as
//   Array<{ id: number; body: string }> (numeric ids from store.nextCommentId, shared
//   with REST), in insertion order, and issue.comments is incremented by 1. The REST
//   surface (GET /repos/{o}/{r}/issues/{n}/comments) reads that same list, so a
//   GraphQL addComment is visible over REST and vice versa. GraphQL returns the
//   opaque id C_<repo>_<issue>_<numId> for a comment.
//
// Determinism: no Date.now(), no Math.random(), no new Date(). Cursors are
// base64("cursor:<offset>") over the filtered+sorted list. Nothing here writes
// timestamps or random values into stored state.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER_LOGIN, parseCommit, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { isAuthorized, parseJson, pathOf, readBody, requestIdHeader, sendJson } from './util.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---- global ids ----------------------------------------------------------------

function repoGlobalId(repo: Repo): string {
  return `R_${repo.id}`;
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return `I_${repo.id}_${issue.number}`;
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return `PR_${repo.id}_${pull.number}`;
}

function findRepoByDbId(store: Store, dbId: number): Repo | undefined {
  for (const repo of store.repos.values()) {
    if (repo.id === dbId) return repo;
  }
  return undefined;
}

function decodeRepoId(store: Store, id: unknown): Repo | undefined {
  if (typeof id !== 'string') return undefined;
  const m = /^R_(\d+)$/.exec(id) ?? /^(\d+)$/.exec(id);
  if (!m) return undefined;
  return findRepoByDbId(store, Number(m[1]));
}

function decodeIssueId(store: Store, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const m = /^I_(\d+)_(\d+)$/.exec(id);
  if (!m) return null;
  const repo = findRepoByDbId(store, Number(m[1]));
  if (!repo) return null;
  const issue = store.getIssue(repo, Number(m[2]));
  if (!issue) return null;
  return { repo, issue };
}

function decodePullId(store: Store, id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const m = /^PR_(\d+)_(\d+)$/.exec(id);
  if (!m) return null;
  const repo = findRepoByDbId(store, Number(m[1]));
  if (!repo) return null;
  const pull = store.getPull(repo, Number(m[2]));
  if (!pull) return null;
  return { repo, pull };
}

// ---- comments (shared with REST via store.getIssueComments) --------------------
// Stored on the Issue object as numeric ids; GraphQL derives its opaque string id
// (C_<repo>_<issue>_<numId>) when returning a comment.

function issueComments(store: Store, issue: Issue): Array<{ id: number; body: string }> {
  return store.getIssueComments(issue);
}

// ---- cursors -------------------------------------------------------------------

function encodeCursor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}

function decodeCursor(value: string): number | null {
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// ---- schema table (validation + introspection) ---------------------------------

interface FieldDef {
  type: string;
  args?: Record<string, string>;
}

interface TypeDef {
  kind: 'OBJECT' | 'INTERFACE' | 'ENUM' | 'SCALAR' | 'INPUT_OBJECT';
  fields?: Record<string, FieldDef>;
  enumValues?: string[];
}

const TYPES: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: { type: 'User' },
      repository: { type: 'Repository', args: { owner: 'String!', name: 'String!' } },
      node: { type: 'Node', args: { id: 'ID!' } },
      __type: { type: '__Type', args: { name: 'String!' } },
      __schema: { type: '__Schema' },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: { type: 'CreateIssuePayload', args: { input: 'CreateIssueInput!' } },
      closeIssue: { type: 'CloseIssuePayload', args: { input: 'CloseIssueInput!' } },
      createPullRequest: { type: 'CreatePullRequestPayload', args: { input: 'CreatePullRequestInput!' } },
      mergePullRequest: { type: 'MergePullRequestPayload', args: { input: 'MergePullRequestInput!' } },
      addComment: { type: 'AddCommentPayload', args: { input: 'AddCommentInput!' } },
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      databaseId: { type: 'Int!' },
      name: { type: 'String!' },
      nameWithOwner: { type: 'String!' },
      description: { type: 'String' },
      owner: { type: 'User' },
      defaultBranchRef: { type: 'Ref' },
      viewerPermission: { type: 'RepositoryPermission' },
      hasIssuesEnabled: { type: 'Boolean' },
      issue: { type: 'Issue', args: { number: 'Int!' } },
      issues: { type: 'IssueConnection', args: { first: 'Int', after: 'String', states: '[IssueState!]', orderBy: 'IssueOrder' } },
      pullRequest: { type: 'PullRequest', args: { number: 'Int!' } },
      pullRequests: { type: 'PullRequestConnection', args: { first: 'Int', after: 'String', states: '[PullRequestState!]' } },
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      number: { type: 'Int!' },
      title: { type: 'String!' },
      state: { type: 'IssueState!' },
      body: { type: 'String' },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      number: { type: 'Int!' },
      title: { type: 'String' },
      body: { type: 'String' },
      state: { type: 'PullRequestState!' },
      merged: { type: 'Boolean' },
      headRefName: { type: 'String' },
      baseRefName: { type: 'String' },
      mergeable: { type: 'MergeableState' },
      files: { type: 'PullRequestChangedFileConnection', args: { first: 'Int' } },
    },
  },
  User: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      login: { type: 'String!' },
      name: { type: 'String' },
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      name: { type: 'String' },
    },
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[Issue]' },
      edges: { type: '[IssueEdge]' },
      pageInfo: { type: 'PageInfo!' },
      totalCount: { type: 'Int!' },
    },
  },
  IssueEdge: {
    kind: 'OBJECT',
    fields: {
      node: { type: 'Issue' },
      cursor: { type: 'String!' },
    },
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequest]' },
      edges: { type: '[PullRequestEdge]' },
      pageInfo: { type: 'PageInfo!' },
      totalCount: { type: 'Int!' },
    },
  },
  PullRequestEdge: {
    kind: 'OBJECT',
    fields: {
      node: { type: 'PullRequest' },
      cursor: { type: 'String!' },
    },
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequestChangedFile]' },
      edges: { type: '[PullRequestChangedFileEdge]' },
      pageInfo: { type: 'PageInfo!' },
      totalCount: { type: 'Int!' },
    },
  },
  PullRequestChangedFileEdge: {
    kind: 'OBJECT',
    fields: {
      node: { type: 'PullRequestChangedFile' },
      cursor: { type: 'String!' },
    },
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: {
      path: { type: 'String!' },
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { type: 'Boolean!' },
      hasPreviousPage: { type: 'Boolean!' },
      startCursor: { type: 'String' },
      endCursor: { type: 'String' },
    },
  },
  Node: {
    kind: 'INTERFACE',
    fields: {
      id: { type: 'ID!' },
    },
  },
  CreateIssuePayload: { kind: 'OBJECT', fields: { issue: { type: 'Issue' } } },
  CloseIssuePayload: { kind: 'OBJECT', fields: { issue: { type: 'Issue' } } },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: { type: 'PullRequest' } } },
  MergePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: { type: 'PullRequest' } } },
  AddCommentPayload: { kind: 'OBJECT', fields: { commentEdge: { type: 'IssueCommentEdge' } } },
  IssueCommentEdge: {
    kind: 'OBJECT',
    fields: {
      node: { type: 'IssueComment' },
      cursor: { type: 'String!' },
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      body: { type: 'String!' },
    },
  },
  CreateIssueInput: {
    kind: 'INPUT_OBJECT',
    fields: {
      repositoryId: { type: 'ID!' },
      title: { type: 'String!' },
      body: { type: 'String' },
    },
  },
  CloseIssueInput: {
    kind: 'INPUT_OBJECT',
    fields: {
      issueId: { type: 'ID!' },
    },
  },
  CreatePullRequestInput: {
    kind: 'INPUT_OBJECT',
    fields: {
      repositoryId: { type: 'ID!' },
      baseRefName: { type: 'String!' },
      headRefName: { type: 'String!' },
      title: { type: 'String!' },
      body: { type: 'String' },
    },
  },
  MergePullRequestInput: {
    kind: 'INPUT_OBJECT',
    fields: {
      pullRequestId: { type: 'ID!' },
      mergeMethod: { type: 'PullRequestMergeMethod' },
    },
  },
  AddCommentInput: {
    kind: 'INPUT_OBJECT',
    fields: {
      subjectId: { type: 'ID!' },
      body: { type: 'String!' },
    },
  },
  IssueOrder: {
    kind: 'INPUT_OBJECT',
    fields: {
      field: { type: 'IssueOrderField!' },
      direction: { type: 'OrderDirection!' },
    },
  },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'DISCUSSION'] },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  __Schema: {
    kind: 'OBJECT',
    fields: {
      description: { type: 'String' },
      queryType: { type: '__Type' },
      mutationType: { type: '__Type' },
      subscriptionType: { type: '__Type' },
      types: { type: '[__Type!]!' },
      directives: { type: '[__Directive!]!' },
    },
  },
  __Type: {
    kind: 'OBJECT',
    fields: {
      kind: { type: '__TypeKind!' },
      name: { type: 'String' },
      description: { type: 'String' },
      fields: { type: '[__Field!]', args: { includeDeprecated: 'Boolean' } },
      enumValues: { type: '[__EnumValue!]', args: { includeDeprecated: 'Boolean' } },
      interfaces: { type: '[__Type!]' },
      possibleTypes: { type: '[__Type!]' },
      inputFields: { type: '[__InputValue!]' },
      ofType: { type: '__Type' },
      specifiedByURL: { type: 'String' },
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String' },
      args: { type: '[__InputValue!]!' },
      type: { type: '__Type!' },
      isDeprecated: { type: 'Boolean!' },
      deprecationReason: { type: 'String' },
    },
  },
  __InputValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String' },
      type: { type: '__Type!' },
      defaultValue: { type: 'String' },
    },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String' },
      isDeprecated: { type: 'Boolean!' },
      deprecationReason: { type: 'String' },
    },
  },
  __Directive: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String' },
      locations: { type: '[__DirectiveLocation!]!' },
      args: { type: '[__InputValue!]!' },
      isRepeatable: { type: 'Boolean!' },
    },
  },
  __TypeKind: {
    kind: 'ENUM',
    enumValues: ['SCALAR', 'OBJECT', 'FIELD_DEFINITION', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'],
  },
  __DirectiveLocation: {
    kind: 'ENUM',
    enumValues: [
      'QUERY', 'MUTATION', 'SUBSCRIPTION', 'FIELD', 'FRAGMENT_DEFINITION', 'FRAGMENT_SPREAD',
      'INLINE_FRAGMENT', 'SCHEMA', 'SCALAR', 'OBJECT', 'FIELD_DEFINITION', 'ARGUMENT_DEFINITION',
      'INTERFACE', 'UNION', 'ENUM', 'ENUM_VALUE', 'INPUT_OBJECT', 'INPUT_FIELD_DEFINITION',
    ],
  },
};

/** Strip list / non-null wrappers to the named type. */
function namedType(t: string): string {
  let s = t;
  while (s.endsWith('!')) s = s.slice(0, -1);
  while (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  while (s.endsWith('!')) s = s.slice(0, -1);
  return s;
}

/** A type reference as an introspection __Type object {kind, name, ofType}. */
function typeRef(t: string): Record<string, unknown> {
  if (t.endsWith('!')) return { __typename: '__Type', kind: 'NON_NULL', name: null, ofType: typeRef(t.slice(0, -1)) };
  if (t.startsWith('[') && t.endsWith(']')) return { __typename: '__Type', kind: 'LIST', name: null, ofType: typeRef(t.slice(1, -1)) };
  const def = TYPES[t];
  return { __typename: '__Type', kind: def ? def.kind : 'SCALAR', name: t, ofType: null };
}

function introspectType(name: string): Record<string, unknown> | null {
  const def = TYPES[name];
  if (!def) return null;
  let fields: unknown = null;
  let enumValues: unknown = null;
  let inputFields: unknown = null;
  let interfaces: unknown = null;
  if (def.kind === 'OBJECT' || def.kind === 'INTERFACE') {
    fields = Object.entries(def.fields ?? {}).map(([fname, f]) => ({
      __typename: '__Field',
      name: fname,
      description: null,
      args: Object.entries(f.args ?? {}).map(([an, at]) => ({
        __typename: '__InputValue', name: an, description: null, type: typeRef(at), defaultValue: null,
      })),
      type: typeRef(f.type),
      isDeprecated: false,
      deprecationReason: null,
    }));
    interfaces = [];
  }
  if (def.kind === 'ENUM') {
    enumValues = (def.enumValues ?? []).map((n) => ({
      __typename: '__EnumValue', name: n, description: null, isDeprecated: false, deprecationReason: null,
    }));
  }
  if (def.kind === 'INPUT_OBJECT') {
    inputFields = Object.entries(def.fields ?? {}).map(([fname, f]) => ({
      __typename: '__InputValue', name: fname, description: null, type: typeRef(f.type), defaultValue: null,
    }));
  }
  return {
    __typename: '__Type',
    kind: def.kind,
    name,
    description: null,
    fields,
    enumValues,
    interfaces,
    possibleTypes: null,
    inputFields,
    ofType: null,
    specifiedByURL: null,
  };
}

function introspectSchema(): Record<string, unknown> {
  return {
    __typename: '__Schema',
    description: null,
    queryType: introspectType('Query'),
    mutationType: introspectType('Mutation'),
    subscriptionType: null,
    types: Object.keys(TYPES).map((n) => introspectType(n)),
    directives: [],
  };
}

// ---- lexer + parser -------------------------------------------------------------

interface Token {
  kind: 'Name' | 'Int' | 'Float' | 'String' | 'Punct' | 'EOF';
  value: string;
}

function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        if (end < 0) throw new Error('Unterminated block string');
        let raw = src.slice(i + 3, end);
        if (raw.startsWith('\n')) raw = raw.slice(1);
        tokens.push({ kind: 'String', value: raw });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < n) {
        const ch = src[j] as string;
        if (ch === '"') break;
        if (ch === '\\') {
          const esc = src[j + 1] as string;
          if (esc === 'u') {
            const hex = src.slice(j + 2, j + 6);
            out += String.fromCharCode(Number.parseInt(hex, 16));
            j += 6;
          } else {
            const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
            out += map[esc] ?? esc;
            j += 2;
          }
          continue;
        }
        if (ch === '\n') throw new Error('Unterminated string');
        out += ch;
        j += 1;
      }
      if (j >= n) throw new Error('Unterminated string');
      tokens.push({ kind: 'String', value: out });
      i = j + 1;
      continue;
    }
    if (c === '.') {
      if (src.startsWith('...', i)) {
        tokens.push({ kind: 'Punct', value: '...' });
        i += 3;
        continue;
      }
      throw new Error(`Unexpected character '.'`);
    }
    if ('!$&():=@[]{}|'.includes(c)) {
      tokens.push({ kind: 'Punct', value: c });
      i += 1;
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i;
      if (src[j] === '-') j += 1;
      let isFloat = false;
      while (j < n && /[0-9]/.test(src[j] as string)) j += 1;
      if (src[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < n && /[0-9]/.test(src[j] as string)) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < n && /[0-9]/.test(src[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'Float' : 'Int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < n && /[_0-9A-Za-z]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'Name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'EOF', value: '' });
  return tokens;
}

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'String'; value: string }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldSelection {
  kind: 'Field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[] | null;
}

interface FragmentSpreadSelection {
  kind: 'FragmentSpread';
  name: string;
}

interface InlineFragmentSelection {
  kind: 'InlineFragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldSelection | FragmentSpreadSelection | InlineFragmentSelection;

interface VarDef {
  name: string;
  type: string;
  defaultValue: ValueNode | null;
}

interface OperationDef {
  kind: 'Operation';
  op: 'query' | 'mutation' | 'subscription';
  name: string | null;
  varDefs: VarDef[];
  selections: SelectionNode[];
}

interface FragmentDef {
  kind: 'Fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface Document {
  operations: OperationDef[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  next(): Token {
    const t = this.tokens[this.pos] as Token;
    this.pos += 1;
    return t;
  }

  private isPunct(value: string): boolean {
    const t = this.peek();
    return t.kind === 'Punct' && t.value === value;
  }

  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'Punct' || t.value !== value) throw new Error(`Expected "${value}" but got "${t.value}"`);
  }

  private expectName(expected?: string): string {
    const t = this.next();
    if (t.kind !== 'Name') throw new Error(`Expected a name but got "${t.value}"`);
    if (expected !== undefined && t.value !== expected) throw new Error(`Expected "${expected}" but got "${t.value}"`);
    return t.value;
  }

  skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) this.parseArgs();
    }
  }

  parseDocument(): Document {
    const operations: OperationDef[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'EOF') {
      if (this.isPunct('{')) {
        operations.push({ kind: 'Operation', op: 'query', name: null, varDefs: [], selections: this.parseSelectionSet() });
      } else if (this.peek().kind === 'Name' && this.peek().value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        this.skipDirectives();
        const selections = this.parseSelectionSet();
        fragments.set(name, { kind: 'Fragment', name, typeCondition, selections });
      } else {
        const kw = this.expectName();
        if (kw !== 'query' && kw !== 'mutation' && kw !== 'subscription') {
          throw new Error(`Unexpected definition "${kw}"`);
        }
        let name: string | null = null;
        if (this.peek().kind === 'Name') name = this.next().value;
        const varDefs = this.isPunct('(') ? this.parseVarDefs() : [];
        this.skipDirectives();
        const selections = this.parseSelectionSet();
        operations.push({ kind: 'Operation', op: kw, name, varDefs, selections });
      }
    }
    return { operations, fragments };
  }

  private parseVarDefs(): VarDef[] {
    const defs: VarDef[] = [];
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.isPunct('=')) {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, type, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): string {
    let t: string;
    if (this.isPunct('[')) {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      t = `[${inner}]`;
    } else {
      t = this.expectName();
    }
    if (this.isPunct('!')) {
      this.next();
      t += '!';
    }
    return t;
  }

  private parseSelectionSet(): SelectionNode[] {
    const selections: SelectionNode[] = [];
    this.expectPunct('{');
    while (!this.isPunct('}')) {
      if (this.peek().kind === 'EOF') throw new Error('Unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.isPunct('...')) {
      this.next();
      if (this.peek().kind === 'Name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'InlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'Name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'FragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'InlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.isPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.isPunct('(') ? this.parseArgs() : [];
    this.skipDirectives();
    const selections = this.isPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'Field', alias, name, args, selections };
  }

  private parseArgs(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.peek();
    if (t.kind === 'Punct' && t.value === '$') {
      this.next();
      return { kind: 'Variable', name: this.expectName() };
    }
    if (t.kind === 'Int') {
      this.next();
      return { kind: 'Int', value: Number.parseInt(t.value, 10) };
    }
    if (t.kind === 'Float') {
      this.next();
      return { kind: 'Float', value: Number.parseFloat(t.value) };
    }
    if (t.kind === 'String') {
      this.next();
      return { kind: 'String', value: t.value };
    }
    if (t.kind === 'Punct' && t.value === '[') {
      this.next();
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'List', values };
    }
    if (t.kind === 'Punct' && t.value === '{') {
      this.next();
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'Object', fields };
    }
    if (t.kind === 'Name') {
      this.next();
      if (t.value === 'true') return { kind: 'Boolean', value: true };
      if (t.value === 'false') return { kind: 'Boolean', value: false };
      if (t.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: t.value };
    }
    throw new Error(`Unexpected value token "${t.value}"`);
  }
}

function parseDocument(src: string): Document {
  return new Parser(lex(src)).parseDocument();
}

// ---- value evaluation + validation ---------------------------------------------

function valueFromAst(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable':
      return vars[node.name];
    case 'Int':
    case 'Float':
    case 'String':
    case 'Boolean':
      return node.value;
    case 'Null':
      return null;
    case 'Enum':
      return node.value;
    case 'List':
      return node.values.map((v) => valueFromAst(v, vars));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = valueFromAst(f.value, vars);
      return out;
    }
  }
}

function evalArgs(args: Array<{ name: string; value: ValueNode }>, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of args) {
    const v = valueFromAst(a.value, vars);
    if (v !== undefined) out[a.name] = v;
  }
  return out;
}

function resolveVariables(op: OperationDef, provided: Record<string, unknown>): Record<string, unknown> {
  const vars: Record<string, unknown> = { ...provided };
  for (const def of op.varDefs) {
    if (!(def.name in vars) || vars[def.name] === undefined) {
      if (def.defaultValue !== null) vars[def.name] = valueFromAst(def.defaultValue, vars);
    }
  }
  return vars;
}

/** Walk a selection set against the schema; collect "Cannot query field ..." errors. */
function validateSelections(
  selections: SelectionNode[],
  parentType: string,
  fragments: Map<string, FragmentDef>,
  errors: string[],
  seenFragments: Set<string>,
): void {
  const def = TYPES[parentType];
  for (const sel of selections) {
    if (sel.kind === 'Field') {
      if (sel.name === '__typename') continue;
      const fieldDef = def?.fields?.[sel.name];
      if (!fieldDef) {
        errors.push(`Cannot query field "${sel.name}" on type "${parentType}".`);
        continue;
      }
      if (sel.selections) {
        const child = namedType(fieldDef.type);
        const childDef = TYPES[child];
        if (!childDef || childDef.kind === 'SCALAR' || childDef.kind === 'ENUM') {
          errors.push(`Field "${sel.name}" must not have a selection since type "${child}" has no subfields.`);
        } else {
          validateSelections(sel.selections, child, fragments, errors, seenFragments);
        }
      }
    } else if (sel.kind === 'FragmentSpread') {
      const frag = fragments.get(sel.name);
      if (!frag) {
        errors.push(`Unknown fragment "${sel.name}".`);
        continue;
      }
      if (seenFragments.has(sel.name)) continue;
      seenFragments.add(sel.name);
      validateSelections(frag.selections, frag.typeCondition, fragments, errors, seenFragments);
    } else {
      validateSelections(sel.selections, sel.typeCondition ?? parentType, fragments, errors, seenFragments);
    }
  }
}

function validateOperation(op: OperationDef, fragments: Map<string, FragmentDef>): string[] {
  const errors: string[] = [];
  const root = op.op === 'mutation' ? 'Mutation' : 'Query';
  validateSelections(op.selections, root, fragments, errors, new Set<string>());
  return errors;
}

// ---- execution -----------------------------------------------------------------

interface ExecCtx {
  store: Store;
  vars: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

function repoParent(repo: Repo): Record<string, unknown> {
  return { __typename: 'Repository', __repo: repo };
}

function issueParent(repo: Repo, issue: Issue): Record<string, unknown> {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}

function pullParent(repo: Repo, pull: Pull): Record<string, unknown> {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull };
}

function userParent(login: string, id: number, name: string): Record<string, unknown> {
  return { __typename: 'User', __login: login, __id: id, __name: name };
}

/** Paths changed on a pull request: head tree vs base tree (live refs win). */
function changedFiles(store: Store, repo: Repo, pull: Pull): string[] {
  const treeOf = (sha: string | null | undefined): Map<string, { mode: string; sha: string }> | null => {
    if (!sha) return null;
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') return null;
    return store.flattenTree(repo, parseCommit(obj.data).tree);
  };
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const headFiles = treeOf(headSha);
  if (!headFiles) return [];
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  const baseFiles = treeOf(baseSha);
  if (!baseFiles) return [...headFiles.keys()].sort();
  const out: string[] = [];
  for (const [p, v] of headFiles) {
    const b = baseFiles.get(p);
    if (!b || b.sha !== v.sha) out.push(p);
  }
  for (const p of baseFiles.keys()) {
    if (!headFiles.has(p)) out.push(p);
  }
  return out.sort();
}

function buildConnection(
  typename: string,
  edgeTypename: string,
  items: unknown[],
  first: unknown,
  after: unknown,
  nodeOf: (item: never) => Record<string, unknown>,
): Record<string, unknown> {
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    const off = decodeCursor(after);
    if (off !== null) start = Math.min(off, items.length);
  }
  const limit = typeof first === 'number' && Number.isFinite(first) ? Math.max(0, Math.floor(first)) : items.length;
  const slice = items.slice(start, start + limit);
  const end = start + slice.length;
  const nodes = slice.map((item) => nodeOf(item as never));
  const edges = slice.map((_, i) => ({
    __typename: edgeTypename,
    __node: nodes[i],
    __cursor: encodeCursor(start + i + 1),
  }));
  const pageInfo: Record<string, unknown> = {
    __typename: 'PageInfo',
    hasNextPage: end < items.length,
    hasPreviousPage: start > 0,
    startCursor: slice.length > 0 ? encodeCursor(start + 1) : null,
    endCursor: slice.length > 0 ? encodeCursor(end) : null,
  };
  return { __typename: typename, __nodes: nodes, __edges: edges, __pageInfo: pageInfo, __total: items.length };
}

function sortedIssues(repo: Repo, args: Record<string, unknown>): Issue[] {
  let list = [...repo.issues];
  if (Array.isArray(args.states)) {
    const want = new Set(args.states.map((s) => String(s)));
    list = list.filter((i) => want.has(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const field = orderBy ? String(orderBy.field ?? 'CREATED_AT') : 'CREATED_AT';
  const direction = orderBy ? String(orderBy.direction ?? 'ASC') : 'ASC';
  const keyOf = (i: Issue): number => (field === 'COMMENTS' ? i.comments : i.createdSeq);
  list.sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka !== kb) return direction === 'DESC' ? kb - ka : ka - kb;
    return direction === 'DESC' ? b.number - a.number : a.number - b.number;
  });
  return list;
}

function sortedPulls(repo: Repo, args: Record<string, unknown>): Pull[] {
  let list = [...repo.pulls];
  if (Array.isArray(args.states)) {
    const want = new Set(args.states.map((s) => String(s)));
    list = list.filter((p) => {
      const state = p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED';
      return want.has(state);
    });
  }
  list.sort((a, b) => (a.createdSeq !== b.createdSeq ? b.createdSeq - a.createdSeq : b.number - a.number));
  return list;
}

function issueStateValue(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateValue(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

// ---- field resolution ----------------------------------------------------------

function resolveField(ctx: ExecCtx, parentType: string, parent: Record<string, unknown>, fieldName: string, args: Record<string, unknown>): unknown {
  const store = ctx.store;
  if (fieldName === '__typename') return (parent.__typename as string | undefined) ?? parentType;

  // Introspection types and other plain-data parents: read the property.
  if (parentType.startsWith('__') || parentType === 'PageInfo') {
    const v = parent[fieldName];
    return v === undefined ? null : v;
  }

  switch (parentType) {
    case 'Query': {
      if (fieldName === 'viewer') {
        return userParent(store.viewer.login, store.viewer.id, store.viewer.name);
      }
      if (fieldName === 'repository') {
        const repo = typeof args.owner === 'string' && typeof args.name === 'string'
          ? store.getRepo(args.owner, args.name)
          : undefined;
        return repo ? repoParent(repo) : null;
      }
      if (fieldName === 'node') {
        const id = args.id;
        if (typeof id !== 'string') return null;
        const repoMatch = /^R_(\d+)$/.exec(id) ?? /^(\d+)$/.exec(id);
        if (repoMatch) {
          const repo = findRepoByDbId(store, Number(repoMatch[1]));
          return repo ? repoParent(repo) : null;
        }
        const issueMatch = decodeIssueId(store, id);
        if (issueMatch) return issueParent(issueMatch.repo, issueMatch.issue);
        const pullMatch = decodePullId(store, id);
        if (pullMatch) return pullParent(pullMatch.repo, pullMatch.pull);
        return null;
      }
      if (fieldName === '__type') {
        if (typeof args.name !== 'string') return null;
        return introspectType(args.name);
      }
      if (fieldName === '__schema') return introspectSchema();
      break;
    }
    case 'Mutation': {
      if (fieldName === 'createIssue') return mutateCreateIssue(ctx, args);
      if (fieldName === 'closeIssue') return mutateCloseIssue(ctx, args);
      if (fieldName === 'createPullRequest') return mutateCreatePullRequest(ctx, args);
      if (fieldName === 'mergePullRequest') return mutateMergePullRequest(ctx, args);
      if (fieldName === 'addComment') return mutateAddComment(ctx, args);
      break;
    }
    case 'Node': {
      if (fieldName === 'id') {
        const t = parent.__typename as string | undefined;
        if (t === 'Repository') return repoGlobalId(parent.__repo as Repo);
        if (t === 'Issue') return issueGlobalId(parent.__repo as Repo, parent.__issue as Issue);
        if (t === 'PullRequest') return pullGlobalId(parent.__repo as Repo, parent.__pull as Pull);
      }
      break;
    }
    case 'Repository': {
      const repo = parent.__repo as Repo;
      switch (fieldName) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return repo.fullName;
        case 'description': return repo.description;
        case 'owner': {
          const id = repo.owner === VIEWER_LOGIN ? store.viewer.id : 0;
          return userParent(repo.owner, id, repo.owner);
        }
        case 'defaultBranchRef': {
          const ref = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return ref === undefined ? null : { __typename: 'Ref', __name: repo.defaultBranch };
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'issue': {
          const n = args.number;
          if (typeof n !== 'number') return null;
          const issue = store.getIssue(repo, n);
          return issue ? issueParent(repo, issue) : null;
        }
        case 'issues':
          return buildConnection('IssueConnection', 'IssueEdge', sortedIssues(repo, args), args.first, args.after, (issue: Issue) => issueParent(repo, issue));
        case 'pullRequest': {
          const n = args.number;
          if (typeof n !== 'number') return null;
          const pull = store.getPull(repo, n);
          return pull ? pullParent(repo, pull) : null;
        }
        case 'pullRequests':
          return buildConnection('PullRequestConnection', 'PullRequestEdge', sortedPulls(repo, args), args.first, args.after, (pull: Pull) => pullParent(repo, pull));
        default: break;
      }
      break;
    }
    case 'Issue': {
      const repo = parent.__repo as Repo;
      const issue = parent.__issue as Issue;
      switch (fieldName) {
        case 'id': return issueGlobalId(repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issueStateValue(issue);
        case 'body': return issue.body;
        default: break;
      }
      break;
    }
    case 'PullRequest': {
      const repo = parent.__repo as Repo;
      const pull = parent.__pull as Pull;
      switch (fieldName) {
        case 'id': return pullGlobalId(repo, pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pullStateValue(pull);
        case 'merged': return pull.merged;
        case 'headRefName': return pull.head;
        case 'baseRefName': return pull.base;
        case 'mergeable': return pull.mergeable ? 'MERGEABLE' : 'CONFLICTING';
        case 'files': {
          const paths = changedFiles(store, repo, pull);
          return buildConnection(
            'PullRequestChangedFileConnection',
            'PullRequestChangedFileEdge',
            paths,
            args.first,
            undefined,
            (p: string) => ({ __typename: 'PullRequestChangedFile', __path: p }),
          );
        }
        default: break;
      }
      break;
    }
    case 'User': {
      switch (fieldName) {
        case 'id': return `U_${parent.__id as number}`;
        case 'login': return parent.__login as string;
        case 'name': return parent.__name as string;
        default: break;
      }
      break;
    }
    case 'Ref': {
      if (fieldName === 'name') return parent.__name as string;
      if (fieldName === 'id') return `Ref_${parent.__name as string}`;
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      switch (fieldName) {
        case 'nodes': return parent.__nodes as unknown[];
        case 'edges': return parent.__edges as unknown[];
        case 'pageInfo': return parent.__pageInfo as Record<string, unknown>;
        case 'totalCount': return parent.__total as number;
        default: break;
      }
      break;
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'PullRequestChangedFileEdge':
    case 'IssueCommentEdge': {
      if (fieldName === 'node') return parent.__node as Record<string, unknown>;
      if (fieldName === 'cursor') return parent.__cursor as string;
      break;
    }
    case 'PullRequestChangedFile': {
      if (fieldName === 'path') return parent.__path as string;
      break;
    }
    case 'IssueComment': {
      if (fieldName === 'id') return parent.__id as string;
      if (fieldName === 'body') return parent.__body as string;
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (fieldName === 'issue') return parent.__issue as Record<string, unknown>;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (fieldName === 'pullRequest') return parent.__pull as Record<string, unknown>;
      break;
    }
    case 'AddCommentPayload': {
      if (fieldName === 'commentEdge') return parent.__commentEdge as Record<string, unknown>;
      break;
    }
    default: break;
  }
  throw new Error(`Cannot query field "${fieldName}" on type "${parentType}".`);
}

// ---- mutations -----------------------------------------------------------------

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  return isRecord(args.input) ? args.input : {};
}

function mutateCreateIssue(ctx: ExecCtx, args: Record<string, unknown>): Record<string, unknown> {
  const input = inputOf(args);
  const repo = decodeRepoId(ctx.store, input.repositoryId);
  if (!repo) throw new Error(`Repository not found for id ${String(input.repositoryId)}`);
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const issue = ctx.store.createIssue(repo, title, body);
  return { __typename: 'CreateIssuePayload', __issue: issueParent(repo, issue) };
}

function mutateCloseIssue(ctx: ExecCtx, args: Record<string, unknown>): Record<string, unknown> {
  const input = inputOf(args);
  const found = decodeIssueId(ctx.store, input.issueId);
  if (!found) throw new Error(`Issue not found for id ${String(input.issueId)}`);
  found.issue.state = 'closed';
  return { __typename: 'CloseIssuePayload', __issue: issueParent(found.repo, found.issue) };
}

function mutateCreatePullRequest(ctx: ExecCtx, args: Record<string, unknown>): Record<string, unknown> {
  const input = inputOf(args);
  const repo = decodeRepoId(ctx.store, input.repositoryId);
  if (!repo) throw new Error(`Repository not found for id ${String(input.repositoryId)}`);
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const head = typeof input.headRefName === 'string' ? input.headRefName : '';
  const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
  const pull = ctx.store.createPull(repo, title, body, head, base);
  return { __typename: 'CreatePullRequestPayload', __pull: pullParent(repo, pull) };
}

function mutateMergePullRequest(ctx: ExecCtx, args: Record<string, unknown>): Record<string, unknown> {
  const input = inputOf(args);
  const found = decodePullId(ctx.store, input.pullRequestId);
  if (!found) throw new Error(`Pull request not found for id ${String(input.pullRequestId)}`);
  const sha = ctx.store.mergePull(found.repo, found.pull);
  if (sha === null) throw new Error(`Pull request #${found.pull.number} cannot be merged`);
  return { __typename: 'MergePullRequestPayload', __pull: pullParent(found.repo, found.pull) };
}

function mutateAddComment(ctx: ExecCtx, args: Record<string, unknown>): Record<string, unknown> {
  const input = inputOf(args);
  const found = decodeIssueId(ctx.store, input.subjectId);
  if (!found) throw new Error(`Issue not found for id ${String(input.subjectId)}`);
  const body = typeof input.body === 'string' ? input.body : '';
  const list = issueComments(ctx.store, found.issue);
  const numId = ctx.store.nextCommentId++;
  const id = `C_${found.repo.id}_${found.issue.number}_${numId}`;
  list.push({ id: numId, body });
  found.issue.comments += 1;
  return {
    __typename: 'AddCommentPayload',
    __commentEdge: {
      __typename: 'IssueCommentEdge',
      __node: { __typename: 'IssueComment', __id: id, __body: body },
      __cursor: id,
    },
  };
}

// ---- selection execution -------------------------------------------------------

function executeSelections(
  ctx: ExecCtx,
  parentType: string,
  parent: Record<string, unknown>,
  selections: SelectionNode[],
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'Field') {
      const key = sel.alias ?? sel.name;
      const fieldDef = TYPES[parentType]?.fields?.[sel.name];
      const childType = sel.name === '__typename' ? null : fieldDef ? namedType(fieldDef.type) : null;
      try {
        const args = evalArgs(sel.args, ctx.vars);
        const value = resolveField(ctx, parentType, parent, sel.name, args);
        if (sel.selections && value !== null && value !== undefined && childType !== null) {
          if (Array.isArray(value)) {
            out[key] = value.map((item, i) =>
              item === null || item === undefined || typeof item !== 'object'
                ? null
                : executeSelections(ctx, childType, item as Record<string, unknown>, sel.selections as SelectionNode[], [...path, key, i]),
            );
          } else if (typeof value === 'object') {
            out[key] = executeSelections(ctx, childType, value as Record<string, unknown>, sel.selections, [...path, key]);
          } else {
            out[key] = value;
          }
        } else {
          out[key] = value === undefined ? null : value;
        }
      } catch (err) {
        ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: [...path, key] });
        out[key] = null;
      }
    } else if (sel.kind === 'FragmentSpread') {
      const frag = ctx.fragments.get(sel.name);
      if (!frag) {
        ctx.errors.push({ message: `Unknown fragment "${sel.name}".`, path });
        continue;
      }
      const typename = parent.__typename as string | undefined;
      if (typename !== undefined && typename !== frag.typeCondition) continue;
      Object.assign(out, executeSelections(ctx, frag.typeCondition, parent, frag.selections, path));
    } else {
      const t = sel.typeCondition ?? parentType;
      const typename = parent.__typename as string | undefined;
      if (sel.typeCondition !== null && typename !== undefined && typename !== sel.typeCondition) continue;
      Object.assign(out, executeSelections(ctx, t, parent, sel.selections, path));
    }
  }
  return out;
}

function executeOperation(store: Store, op: OperationDef, fragments: Map<string, FragmentDef>, providedVars: Record<string, unknown>): Record<string, unknown> {
  if (op.op === 'subscription') {
    return { data: null, errors: [{ message: 'Subscriptions are not supported.' }] };
  }
  const vars = resolveVariables(op, providedVars);
  const errors = validateOperation(op, fragments);
  if (errors.length > 0) {
    return { data: null, errors: errors.map((message) => ({ message })) };
  }
  const ctx: ExecCtx = { store, vars, fragments, errors: [] };
  const rootType = op.op === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(ctx, rootType, { __typename: rootType }, op.selections, []);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

function runBody(store: Store, entry: unknown): unknown {
  if (!isRecord(entry) || typeof entry.query !== 'string') {
    return { data: null, errors: [{ message: 'query must be a string' }] };
  }
  const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
  const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
  let doc: Document;
  try {
    doc = parseDocument(entry.query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation found in document' }] };
  }
  if (operationName !== undefined) {
    const op = doc.operations.find((o) => o.name === operationName);
    if (!op) return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    return executeOperation(store, op, doc.fragments, variables);
  }
  if (doc.operations.length === 1) {
    return executeOperation(store, doc.operations[0] as OperationDef, doc.fragments, variables);
  }
  return doc.operations.map((op) => executeOperation(store, op, doc.fragments, variables));
}

// ---- HTTP entry point ----------------------------------------------------------

export async function handleGraphql(store: Store, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (pathOf(req) !== '/api/graphql') return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method not allowed' }, requestIdHeader(store));
    return true;
  }
  if (!isAuthorized(store, req)) {
    sendJson(res, 401, { message: 'Unauthorized' }, requestIdHeader(store));
    return true;
  }
  const buf = await readBody(req);
  const parsed = parseJson(buf);
  if (!parsed.ok) {
    sendJson(res, 400, { message: parsed.error }, requestIdHeader(store));
    return true;
  }
  const value = parsed.value;
  if (Array.isArray(value)) {
    // GitHub operation batching: one result per operation, in request order.
    sendJson(res, 200, value.map((entry) => runBody(store, entry)), requestIdHeader(store));
    return true;
  }
  if (isRecord(value)) {
    sendJson(res, 200, runBody(store, value), requestIdHeader(store));
    return true;
  }
  sendJson(res, 400, { message: 'expected a JSON object or array' }, requestIdHeader(store));
  return true;
}
