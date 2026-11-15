// GraphQL v4 surface: a small parser plus an executor for exactly the
// documents gh and github-mcp-server send — viewer and repository reads,
// __type feature probes, issue and pull-request reads and connections, the
// five mutations, node(id:) and batched operation documents.
//
// An unknown field is a 200 with an errors array (never an HTTP 400); an
// unknown repository is data.repository = null with no errors. Global ids are
// the store's opaque base64url ids and round-trip across surfaces.

import {
  ForgeStore,
  SERVER_DATE_ISO,
  VIEWER,
  globalId,
  parseGlobalId,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}']);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const push = (token: Token): void => {
    tokens.push(token);
  };
  while (index < source.length) {
    const char = source[index]!;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',' || char === '﻿') {
      index += 1;
      continue;
    }
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (source.startsWith('...', index)) {
      push({ kind: 'punct', value: '...' });
      index += 3;
      continue;
    }
    if (PUNCT.has(char)) {
      push({ kind: 'punct', value: char });
      index += 1;
      continue;
    }
    if (char === '"') {
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        if (end < 0) throw new Error('unterminated block string');
        push({ kind: 'string', value: source.slice(index + 3, end) });
        index = end + 3;
        continue;
      }
      let end = index + 1;
      let value = '';
      while (end < source.length && source[end] !== '"') {
        if (source[end] === '\\') {
          const escaped = source[end + 1];
          const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
          if (escaped === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(end + 2, end + 6), 16));
            end += 6;
          } else {
            value += map[escaped ?? ''] ?? escaped ?? '';
            end += 2;
          }
        } else {
          value += source[end];
          end += 1;
        }
      }
      if (end >= source.length) throw new Error('unterminated string');
      push({ kind: 'string', value });
      index = end + 1;
      continue;
    }
    if (/[0-9-]/.test(char)) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(index));
      if (!match) throw new Error(`bad number at ${index}`);
      const text = match[0];
      push(/[.]|[eE]/.test(text) ? { kind: 'float', value: Number.parseFloat(text) } : { kind: 'int', value: Number.parseInt(text, 10) });
      index += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(char)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(index));
      if (!match) throw new Error(`bad name at ${index}`);
      push({ kind: 'name', value: match[0] });
      index += match[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)} at ${index}`);
  }
  push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

export interface ValueNode {
  kind: 'variable' | 'int' | 'float' | 'string' | 'boolean' | 'null' | 'enum' | 'list' | 'object';
  value: unknown;
}

export interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, ValueNode>;
  selections: SelectionNode[] | null;
}

export interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

export interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  selections: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

type DefinitionNode = OperationNode | FragmentNode;

class Parser {
  private tokens: Token[];
  private position = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.position]!;
  }

  private next(): Token {
    const token = this.tokens[this.position]!;
    this.position += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value}, got ${token.kind === 'eof' ? 'end' : JSON.stringify((token as { value: unknown }).value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.kind}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): DefinitionNode[] {
    const definitions: DefinitionNode[] = [];
    while (this.peek().kind !== 'eof') {
      definitions.push(this.parseDefinition());
    }
    return definitions;
  }

  private parseDefinition(): DefinitionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      this.skipDirectives();
      return { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      const operation = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value as string;
      if (this.isPunct('(')) this.skipVariableDefinitions();
      this.skipDirectives();
      return { kind: 'operation', operation, name, selections: this.parseSelectionSet() };
    }
    throw new Error(`unexpected definition start ${JSON.stringify(token)}`);
  }

  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
      if (token.kind === 'eof') throw new Error('unterminated variable definitions');
    }
  }

  private skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) this.parseArguments();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      selections.push(this.parseSelection());
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.isPunct('...')) {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (token.kind === 'name') {
        const name = this.next().value as string;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.isPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.isPunct('(') ? this.parseArguments() : {};
    this.skipDirectives();
    const selections = this.isPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Record<string, ValueNode> {
    this.expectPunct('(');
    const args: Record<string, ValueNode> = {};
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
      if (this.peek().kind === 'eof') throw new Error('unterminated arguments');
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', value: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.isPunct(']')) {
        items.push(this.parseValue());
        if (this.peek().kind === 'eof') throw new Error('unterminated list');
      }
      this.expectPunct(']');
      return { kind: 'list', value: items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
        if (this.peek().kind === 'eof') throw new Error('unterminated object');
      }
      this.expectPunct('}');
      return { kind: 'object', value: fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value ${JSON.stringify(token)}`);
  }
}

/** Resolve a parsed value against the request's variables. */
function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const name = node.value as string;
      return variables[name] ?? null;
    }
    case 'list':
      return (node.value as ValueNode[]).map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.value as Record<string, ValueNode>)) {
        out[key] = resolveValue(value, variables);
      }
      return out;
    }
    default:
      return node.value;
  }
}

// ---------------------------------------------------------------------------
// schema surface (what __type reports)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest',
    'pullRequests', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'labels', 'comments', 'author'],
  PullRequest: [
    'id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName',
    'mergeable', 'files', 'body', 'headRef', 'baseRef', 'url', 'createdAt', 'updatedAt',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes', 'filename'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'comment', 'clientMutationId'],
  Ref: ['id', 'name', 'prefix', 'target'],
  Label: ['id', 'name', 'color', 'description'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'ofType', 'inputFields'],
  __Field: ['name', 'description', 'type', 'args', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['queryType', 'mutationType', 'subscriptionType', 'types', 'directives'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

const TYPE_KIND: Record<string, string> = {
  Query: 'OBJECT',
  Mutation: 'OBJECT',
  User: 'OBJECT',
  Repository: 'OBJECT',
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeableState: 'ENUM',
  RepositoryPermission: 'ENUM',
  IssueOrderField: 'ENUM',
  OrderDirection: 'ENUM',
  PullRequestMergeMethod: 'ENUM',
};

// ---------------------------------------------------------------------------
// runtime nodes
// ---------------------------------------------------------------------------

type Node =
  | { __kind: 'Query' }
  | { __kind: 'Mutation' }
  | { __kind: 'User'; login: string; id: number }
  | { __kind: 'Repository'; repo: Repo }
  | { __kind: 'Issue'; repo: Repo; issue: Issue }
  | { __kind: 'PullRequest'; repo: Repo; pull: PullRequest }
  | { __kind: 'IssueConnection'; repo: Repo; page: Issue[]; hasNextPage: boolean; endCursor: string | null; startCursor: string | null; total: number }
  | { __kind: 'PullRequestConnection'; repo: Repo; page: PullRequest[]; hasNextPage: boolean; endCursor: string | null; startCursor: string | null; total: number }
  | { __kind: 'FileConnection'; repo: Repo; pull: PullRequest; files: { filename: string; status: string; additions: number; deletions: number; changes: number }[] }
  | { __kind: 'PageInfo'; hasNextPage: boolean; endCursor: string | null; startCursor: string | null }
  | { __kind: 'Edge'; node: Node; cursor: string }
  | { __kind: 'ChangedFile'; path: string; additions: number; deletions: number; changes: number }
  | { __kind: 'Comment'; repo: Repo; issue: Issue; id: number; body: string }
  | { __kind: 'CommentEdge'; node: Node }
  | { __kind: 'Payload'; fields: Record<string, Node | null> }
  | { __kind: 'Ref'; name: string }
  | { __kind: 'Label'; name: string; color: string }
  | { __kind: 'Type'; name: string }
  | { __kind: 'Schema' }
  | { __kind: 'FieldDef'; name: string }
  | { __kind: 'EnumValue'; name: string };

interface Ctx {
  store: ForgeStore;
  errors: { message: string }[];
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

function issueId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
}

function pullId(repo: Repo, pull: PullRequest): string {
  return globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`);
}

function parseEntityId(id: unknown): { kind: string; owner: string; name: string; number: number | null } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed) return null;
  const [ownerAndName, rest] = parsed.key.split('#');
  const [owner, name] = (ownerAndName ?? '').split('/');
  if (!owner || !name) return null;
  let number: number | null = null;
  if (rest !== undefined) {
    const [numberPart] = rest.split(':');
    number = Number.parseInt(numberPart ?? '', 10);
    if (!Number.isInteger(number)) return null;
  }
  return { kind: parsed.kind, owner, name, number };
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

function executeSelectionSet(
  node: Node,
  selections: SelectionNode[],
  ctx: Ctx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      const args: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(selection.args)) {
        args[name] = resolveValue(value, ctx.variables);
      }
      out[key] = executeField(node, selection.name, args, selection.selections, ctx);
    } else if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) {
        Object.assign(out, executeSelectionSet(node, fragment.selections, ctx));
      }
    } else {
      // Inline fragment: apply when the type condition matches this node's kind,
      // or when there is no condition. Node is the Relay interface: its kind is
      // the concrete type of the value it holds.
      if (selection.typeCondition === null || selection.typeCondition === node.__kind) {
        Object.assign(out, executeSelectionSet(node, selection.selections, ctx));
      }
    }
  }
  return out;
}

function unknownField(ctx: Ctx, kind: string, field: string): null {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${kind}".` });
  return null;
}

function executeField(
  node: Node,
  field: string,
  args: Record<string, unknown>,
  selections: SelectionNode[] | null,
  ctx: Ctx,
): unknown {
  if (field === '__typename') return node.__kind;
  switch (node.__kind) {
    case 'Query':
      return executeQueryField(node, field, args, selections, ctx);
    case 'Mutation':
      return executeMutationField(node, field, args, selections, ctx);
    case 'User':
      if (field === 'id') return globalId('User', node.login);
      if (field === 'login') return node.login;
      if (field === 'name') return node.login === VIEWER.login ? VIEWER.name : node.login;
      if (field === 'email') return node.login === VIEWER.login ? VIEWER.email : null;
      return unknownField(ctx, 'User', field);
    case 'Repository':
      return executeRepositoryField(node, field, args, selections, ctx);
    case 'Issue':
      return executeIssueField(node, field, args, selections, ctx);
    case 'PullRequest':
      return executePullRequestField(node, field, args, selections, ctx);
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'FileConnection':
      return executeConnectionField(node, field, args, selections, ctx);
    case 'Edge':
      if (field === 'node') return selections ? executeSelectionSet(node.node, selections, ctx) : node.node;
      if (field === 'cursor') return node.cursor;
      return unknownField(ctx, 'Edge', field);
    case 'ChangedFile':
      if (field === 'path' || field === 'filename') return node.path;
      if (field === 'additions') return node.additions;
      if (field === 'deletions') return node.deletions;
      if (field === 'changes') return node.changes;
      return unknownField(ctx, 'PullRequestChangedFile', field);
    case 'Comment':
      if (field === 'id') return globalId('IssueComment', `${node.repo.owner}/${node.repo.name}#${node.issue.number}:${node.id}`);
      if (field === 'body') return node.body;
      if (field === 'author') return selections ? executeSelectionSet({ __kind: 'User', login: VIEWER.login, id: VIEWER.id }, selections, ctx) : null;
      if (field === 'createdAt' || field === 'updatedAt') return SERVER_DATE_ISO;
      return unknownField(ctx, 'IssueComment', field);
    case 'CommentEdge':
      if (field === 'node') return selections ? executeSelectionSet(node.node, selections, ctx) : node.node;
      if (field === 'cursor') return '';
      return unknownField(ctx, 'IssueCommentEdge', field);
    case 'Payload': {
      const value = node.fields[field];
      if (value === undefined) return unknownField(ctx, 'Payload', field);
      if (value === null) return null;
      return selections ? executeSelectionSet(value, selections, ctx) : value;
    }
    case 'PageInfo':
      if (field === 'hasNextPage') return node.hasNextPage;
      if (field === 'hasPreviousPage') return false;
      if (field === 'startCursor') return node.startCursor;
      if (field === 'endCursor') return node.endCursor;
      return unknownField(ctx, 'PageInfo', field);
    case 'Ref':
      if (field === 'id') return globalId('Ref', node.name);
      if (field === 'name') return node.name;
      if (field === 'prefix') return 'refs/heads/';
      if (field === 'target') return null;
      return unknownField(ctx, 'Ref', field);
    case 'Label':
      if (field === 'id') return globalId('Label', node.name);
      if (field === 'name') return node.name;
      if (field === 'color') return node.color;
      if (field === 'description') return '';
      return unknownField(ctx, 'Label', field);
    case 'Type':
      return executeTypeField(node, field, args, selections, ctx);
    case 'Schema':
      if (field === 'queryType') return selections ? executeSelectionSet({ __kind: 'Type', name: 'Query' }, selections, ctx) : { name: 'Query' };
      if (field === 'mutationType') return selections ? executeSelectionSet({ __kind: 'Type', name: 'Mutation' }, selections, ctx) : { name: 'Mutation' };
      if (field === 'subscriptionType') return null;
      if (field === 'types') {
        const names = [...Object.keys(TYPE_FIELDS), ...Object.keys(TYPE_ENUM_VALUES)];
        return selections ? names.map((name) => executeSelectionSet({ __kind: 'Type', name }, selections, ctx)) : names;
      }
      if (field === 'directives') return [];
      return unknownField(ctx, '__Schema', field);
    case 'FieldDef':
      if (field === 'name') return node.name;
      if (field === 'description') return '';
      if (field === 'type') return { kind: 'SCALAR', name: 'String' };
      if (field === 'args') return [];
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      return unknownField(ctx, '__Field', field);
    case 'EnumValue':
      if (field === 'name') return node.name;
      if (field === 'description') return '';
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      return unknownField(ctx, '__EnumValue', field);
    default:
      return unknownField(ctx, node.__kind, field);
  }
}

function executeQueryField(
  _node: { __kind: 'Query' },
  field: string,
  args: Record<string, unknown>,
  selections: SelectionNode[] | null,
  ctx: Ctx,
): unknown {
  if (field === 'viewer') {
    const user: Node = { __kind: 'User', login: VIEWER.login, id: VIEWER.id };
    return selections ? executeSelectionSet(user, selections, ctx) : user;
  }
  if (field === 'repository') {
    const owner = args.owner as string | undefined;
    const name = args.name as string | undefined;
    if (typeof owner !== 'string' || typeof name !== 'string') return null;
    const repo = ctx.store.getRepo(owner, name);
    if (!repo) return null;
    const node: Node = { __kind: 'Repository', repo };
    return selections ? executeSelectionSet(node, selections, ctx) : node;
  }
  if (field === 'node') {
    const parsed = parseEntityId(args.id);
    if (!parsed) return null;
    const repo = ctx.store.getRepo(parsed.owner, parsed.name);
    if (!repo) return null;
    let node: Node | null = null;
    if (parsed.kind === 'Repository') node = { __kind: 'Repository', repo };
    else if (parsed.kind === 'Issue' && parsed.number !== null) {
      const issue = repo.issues.find((entry) => entry.number === parsed.number);
      if (issue) node = { __kind: 'Issue', repo, issue };
    } else if (parsed.kind === 'PullRequest' && parsed.number !== null) {
      const pull = repo.pulls.find((entry) => entry.number === parsed.number);
      if (pull) node = { __kind: 'PullRequest', repo, pull };
    }
    if (!node) return null;
    return selections ? executeSelectionSet(node, selections, ctx) : node;
  }
  if (field === '__type') {
    const name = args.name as string | undefined;
    if (typeof name !== 'string') return null;
    if (!(name in TYPE_FIELDS) && !(name in TYPE_ENUM_VALUES)) return null;
    const node: Node = { __kind: 'Type', name };
    return selections ? executeSelectionSet(node, selections, ctx) : node;
  }
  if (field === '__schema') {
    const node: Node = { __kind: 'Schema' };
    return selections ? executeSelectionSet(node, selections, ctx) : node;
  }
  return unknownField(ctx, 'Query', field);
}

function executeRepositoryField(
  node: { __kind: 'Repository'; repo: Repo },
  field: string,
  args: Record<string, unknown>,
  selections: SelectionNode[] | null,
  ctx: Ctx,
): unknown {
  const repo = node.repo;
  switch (field) {
    case 'id':
      return globalId('Repository', `${repo.owner}/${repo.name}`);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'description':
      return repo.description;
    case 'url':
      return `https://github.com/${repo.owner}/${repo.name}`;
    case 'createdAt':
    case 'updatedAt':
      return SERVER_DATE_ISO;
    case 'isPrivate':
      return repo.isPrivate;
    case 'owner': {
      const owner: Node = { __kind: 'User', login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 1001 };
      return selections ? executeSelectionSet(owner, selections, ctx) : owner;
    }
    case 'defaultBranchRef': {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!tip) return null;
      const ref: Node = { __kind: 'Ref', name: repo.defaultBranch };
      return selections ? executeSelectionSet(ref, selections, ctx) : ref;
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'issue': {
      const number = args.number as number | undefined;
      if (typeof number !== 'number') return null;
      const issue = repo.issues.find((entry) => entry.number === number);
      if (!issue) return null;
      const issueNode: Node = { __kind: 'Issue', repo, issue };
      return selections ? executeSelectionSet(issueNode, selections, ctx) : issueNode;
    }
    case 'issues': {
      const list = filterAndOrderIssues(repo, args);
      const paged = paginateConnection(list, args);
      const connection: Node = {
        __kind: 'IssueConnection',
        repo,
        page: paged.page,
        hasNextPage: paged.hasNextPage,
        endCursor: paged.endCursor,
        startCursor: paged.startCursor,
        total: list.length,
      };
      return selections ? executeSelectionSet(connection, selections, ctx) : connection;
    }
    case 'pullRequest': {
      const number = args.number as number | undefined;
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (!pull) return null;
      const pullNode: Node = { __kind: 'PullRequest', repo, pull };
      return selections ? executeSelectionSet(pullNode, selections, ctx) : pullNode;
    }
    case 'pullRequests': {
      const list = filterPulls(repo, args);
      const paged = paginateConnection(list, args);
      const connection: Node = {
        __kind: 'PullRequestConnection',
        repo,
        page: paged.page,
        hasNextPage: paged.hasNextPage,
        endCursor: paged.endCursor,
        startCursor: paged.startCursor,
        total: list.length,
      };
      return selections ? executeSelectionSet(connection, selections, ctx) : connection;
    }
    default:
      return unknownField(ctx, 'Repository', field);
  }
}

function filterAndOrderIssues(repo: Repo, args: Record<string, unknown>): Issue[] {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  let list = repo.issues.filter((issue) => !states || states.includes(issue.state.toUpperCase()));
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const fieldName = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = orderBy.direction === 'ASC' ? 1 : -1;
  const key = (issue: Issue): number =>
    fieldName === 'UPDATED_AT' ? issue.updatedSeq : fieldName === 'COMMENTS' ? issue.comments.length : issue.createdSeq;
  list = [...list].sort((a, b) => {
    const diff = (key(a) - key(b)) * direction;
    return diff !== 0 ? diff : (a.number - b.number) * direction;
  });
  return list;
}

function filterPulls(repo: Repo, args: Record<string, unknown>): PullRequest[] {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const toGraphQl = (pull: PullRequest): string => (pull.merged ? 'MERGED' : pull.state.toUpperCase());
  return repo.pulls.filter((pull) => !states || states.includes(toGraphQl(pull)));
}

function paginateConnection<T extends { number: number }>(
  items: T[],
  args: Record<string, unknown>,
): { page: T[]; hasNextPage: boolean; endCursor: string | null; startCursor: string | null } {
  const after = numberFromCursor(args.after);
  let start = 0;
  if (after !== null) {
    const index = items.findIndex((item) => item.number === after);
    start = index < 0 ? 0 : index + 1;
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : items.length - start;
  const page = items.slice(start, start + first);
  const hasNextPage = start + page.length < items.length;
  return {
    page,
    hasNextPage,
    endCursor: page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null,
    startCursor: page.length > 0 ? cursorFor(page[0]!.number) : null,
  };
}

function executeConnectionField(
  node: { __kind: 'IssueConnection'; repo: Repo; page: Issue[]; hasNextPage: boolean; endCursor: string | null; startCursor: string | null; total: number }
    | { __kind: 'PullRequestConnection'; repo: Repo; page: PullRequest[]; hasNextPage: boolean; endCursor: string | null; startCursor: string | null; total: number }
    | { __kind: 'FileConnection'; repo: Repo; pull: PullRequest; files: { filename: string; status: string; additions: number; deletions: number; changes: number }[] },
  field: string,
  args: Record<string, unknown>,
  selections: SelectionNode[] | null,
  ctx: Ctx,
): unknown {
  if (field === 'totalCount') {
    if (node.__kind === 'FileConnection') return node.files.length;
    return node.total;
  }
  if (field === 'pageInfo') {
    const pageInfo: Node = {
      __kind: 'PageInfo',
      hasNextPage: node.__kind === 'FileConnection' ? false : node.hasNextPage,
      endCursor: node.__kind === 'FileConnection' ? null : node.endCursor,
      startCursor: node.__kind === 'FileConnection' ? null : node.startCursor,
    };
    return selections ? executeSelectionSet(pageInfo, selections, ctx) : pageInfo;
  }
  if (field === 'nodes') {
    if (node.__kind === 'IssueConnection') {
      return node.page.map((issue) => {
        const issueNode: Node = { __kind: 'Issue', repo: node.repo, issue };
        return selections ? executeSelectionSet(issueNode, selections, ctx) : issueNode;
      });
    }
    if (node.__kind === 'PullRequestConnection') {
      return node.page.map((pull) => {
        const pullNode: Node = { __kind: 'PullRequest', repo: node.repo, pull };
        return selections ? executeSelectionSet(pullNode, selections, ctx) : pullNode;
      });
    }
    // FileConnection: files were already capped by `first` when built.
    return node.files.map((change) => {
      const fileNode: Node = {
        __kind: 'ChangedFile',
        path: change.filename,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.changes,
      };
      return selections ? executeSelectionSet(fileNode, selections, ctx) : fileNode;
    });
  }
  if (field === 'edges') {
    if (node.__kind === 'IssueConnection') {
      return node.page.map((issue) => {
        const edge: Node = { __kind: 'Edge', node: { __kind: 'Issue', repo: node.repo, issue }, cursor: cursorFor(issue.number) };
        return selections ? executeSelectionSet(edge, selections, ctx) : edge;
      });
    }
    if (node.__kind === 'PullRequestConnection') {
      return node.page.map((pull) => {
        const edge: Node = { __kind: 'Edge', node: { __kind: 'PullRequest', repo: node.repo, pull }, cursor: cursorFor(pull.number) };
        return selections ? executeSelectionSet(edge, selections, ctx) : edge;
      });
    }
    return [];
  }
  const kindName = node.__kind === 'IssueConnection'
    ? 'IssueConnection'
    : node.__kind === 'PullRequestConnection' ? 'PullRequestConnection' : 'PullRequestChangedFileConnection';
  return unknownField(ctx, kindName, field);
}

function executeIssueField(
  node: { __kind: 'Issue'; repo: Repo; issue: Issue },
  field: string,
  args: Record<string, unknown>,
  selections: SelectionNode[] | null,
  ctx: Ctx,
): unknown {
  const issue = node.issue;
  switch (field) {
    case 'id':
      return issueId(node.repo, issue);
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'body':
      return issue.body;
    case 'state':
      return issue.state.toUpperCase();
    case 'url':
      return `https://github.com/${node.repo.owner}/${node.repo.name}/issues/${issue.number}`;
    case 'createdAt':
    case 'updatedAt':
      return SERVER_DATE_ISO;
    case 'labels':
      return issue.labels.map((label) => {
        const labelNode: Node = { __kind: 'Label', name: label.name, color: label.color };
        return selections ? executeSelectionSet(labelNode, selections, ctx) : labelNode;
      });
    case 'comments': {
      const comments = issue.comments.map((comment) => ({
        __kind: 'Comment' as const,
        repo: node.repo,
        issue,
        id: comment.id,
        body: comment.body,
      }));
      return selections
        ? comments.map((comment) => executeSelectionSet(comment, selections, ctx))
        : comments;
    }
    case 'author': {
      const user: Node = { __kind: 'User', login: VIEWER.login, id: VIEWER.id };
      return selections ? executeSelectionSet(user, selections, ctx) : user;
    }
    default:
      return unknownField(ctx, 'Issue', field);
  }
}

function executePullRequestField(
  node: { __kind: 'PullRequest'; repo: Repo; pull: PullRequest },
  field: string,
  args: Record<string, unknown>,
  selections: SelectionNode[] | null,
  ctx: Ctx,
): unknown {
  const pull = node.pull;
  switch (field) {
    case 'id':
      return pullId(node.repo, pull);
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
      return pull.body;
    case 'state':
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    case 'merged':
      return pull.merged;
    case 'headRefName':
      return pull.head.ref;
    case 'baseRefName':
      return pull.base.ref;
    case 'mergeable':
      return ctx.store.pullConflicts(node.repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    case 'files': {
      const all = ctx.store.pullFiles(node.repo, node.pull);
      const first = typeof args.first === 'number' && args.first >= 0 ? args.first : all.length;
      const connection: Node = { __kind: 'FileConnection', repo: node.repo, pull: node.pull, files: all.slice(0, first) };
      return selections ? executeSelectionSet(connection, selections, ctx) : connection;
    }
    case 'headRef': {
      const ref: Node = { __kind: 'Ref', name: pull.head.ref };
      return selections ? executeSelectionSet(ref, selections, ctx) : ref;
    }
    case 'baseRef': {
      const ref: Node = { __kind: 'Ref', name: pull.base.ref };
      return selections ? executeSelectionSet(ref, selections, ctx) : ref;
    }
    case 'url':
      return `https://github.com/${node.repo.owner}/${node.repo.name}/pull/${pull.number}`;
    case 'createdAt':
    case 'updatedAt':
      return SERVER_DATE_ISO;
    default:
      return unknownField(ctx, 'PullRequest', field);
  }
}

function executeTypeField(
  node: { __kind: 'Type'; name: string },
  field: string,
  args: Record<string, unknown>,
  selections: SelectionNode[] | null,
  ctx: Ctx,
): unknown {
  switch (field) {
    case 'name':
      return node.name;
    case 'kind':
      return TYPE_KIND[node.name] ?? 'OBJECT';
    case 'description':
      return '';
    case 'fields': {
      const names = TYPE_FIELDS[node.name] ?? [];
      return names.map((name) => {
        const fieldNode: Node = { __kind: 'FieldDef', name };
        return selections ? executeSelectionSet(fieldNode, selections, ctx) : fieldNode;
      });
    }
    case 'enumValues': {
      const names = TYPE_ENUM_VALUES[node.name] ?? [];
      return names.map((name) => {
        const enumNode: Node = { __kind: 'EnumValue', name };
        return selections ? executeSelectionSet(enumNode, selections, ctx) : enumNode;
      });
    }
    case 'ofType':
      return null;
    case 'inputFields':
      return [];
    default:
      return unknownField(ctx, '__Type', field);
  }
}

function executeMutationField(
  _node: { __kind: 'Mutation' },
  field: string,
  args: Record<string, unknown>,
  selections: SelectionNode[] | null,
  ctx: Ctx,
): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (field) {
    case 'createIssue': {
      const parsed = parseEntityId(input.repositoryId);
      const repo = parsed && parsed.kind === 'Repository' ? ctx.store.getRepo(parsed.owner, parsed.name) : null;
      if (!repo) {
        ctx.errors.push({ message: 'Could not resolve repositoryId to a repository.' });
        return selections ? executeSelectionSet({ __kind: 'Payload', fields: { issue: null } }, selections, ctx) : null;
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const issue: Issue = {
        number: repo.nextIssue++,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: repo.nextIssue,
        updatedSeq: repo.nextIssue,
      };
      repo.issues.push(issue);
      const payload: Node = { __kind: 'Payload', fields: { issue: { __kind: 'Issue', repo, issue } } };
      return selections ? executeSelectionSet(payload, selections, ctx) : payload;
    }
    case 'closeIssue': {
      const parsed = parseEntityId(input.issueId);
      const repo = parsed && parsed.kind === 'Issue' ? ctx.store.getRepo(parsed.owner, parsed.name) : null;
      const issue = repo && parsed?.number !== null && parsed?.number !== undefined
        ? repo.issues.find((entry) => entry.number === parsed.number)
        : undefined;
      if (!repo || !issue) {
        ctx.errors.push({ message: 'Could not resolve issueId to an issue.' });
        return selections ? executeSelectionSet({ __kind: 'Payload', fields: { issue: null } }, selections, ctx) : null;
      }
      issue.state = 'closed';
      const payload: Node = { __kind: 'Payload', fields: { issue: { __kind: 'Issue', repo, issue } } };
      return selections ? executeSelectionSet(payload, selections, ctx) : payload;
    }
    case 'createPullRequest': {
      const parsed = parseEntityId(input.repositoryId);
      const repo = parsed && parsed.kind === 'Repository' ? ctx.store.getRepo(parsed.owner, parsed.name) : null;
      if (!repo) {
        ctx.errors.push({ message: 'Could not resolve repositoryId to a repository.' });
        return selections ? executeSelectionSet({ __kind: 'Payload', fields: { pullRequest: null } }, selections, ctx) : null;
      }
      const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
      const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const headSha = ctx.store.branchTip(repo, headRef);
      const baseSha = ctx.store.branchTip(repo, baseRef);
      if (!headSha || !baseSha) {
        ctx.errors.push({ message: 'head or base branch does not exist.' });
        return selections ? executeSelectionSet({ __kind: 'Payload', fields: { pullRequest: null } }, selections, ctx) : null;
      }
      const pull: PullRequest = {
        number: repo.nextPull++,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        head: { ref: headRef, sha: headSha },
        base: { ref: baseRef, sha: baseSha },
        createdSeq: repo.nextPull,
        updatedSeq: repo.nextPull,
      };
      repo.pulls.push(pull);
      const payload: Node = { __kind: 'Payload', fields: { pullRequest: { __kind: 'PullRequest', repo, pull } } };
      return selections ? executeSelectionSet(payload, selections, ctx) : payload;
    }
    case 'mergePullRequest': {
      const parsed = parseEntityId(input.pullRequestId);
      const repo = parsed && parsed.kind === 'PullRequest' ? ctx.store.getRepo(parsed.owner, parsed.name) : null;
      const pull = repo && parsed?.number !== null && parsed?.number !== undefined
        ? repo.pulls.find((entry) => entry.number === parsed.number)
        : undefined;
      if (!repo || !pull) {
        ctx.errors.push({ message: 'Could not resolve pullRequestId to a pull request.' });
        return selections ? executeSelectionSet({ __kind: 'Payload', fields: { pullRequest: null } }, selections, ctx) : null;
      }
      if (!pull.merged && pull.state === 'open') {
        const mergeSha = ctx.store.squashMerge(repo, pull);
        if (mergeSha) {
          pull.merged = true;
          pull.state = 'closed';
          pull.mergedAt = SERVER_DATE_ISO;
          pull.mergeCommitSha = mergeSha;
        }
      }
      const payload: Node = { __kind: 'Payload', fields: { pullRequest: { __kind: 'PullRequest', repo, pull } } };
      return selections ? executeSelectionSet(payload, selections, ctx) : payload;
    }
    case 'addComment': {
      const parsed = parseEntityId(input.subjectId);
      const repo = parsed && parsed.kind === 'Issue' ? ctx.store.getRepo(parsed.owner, parsed.name) : null;
      const issue = repo && parsed?.number !== null && parsed?.number !== undefined
        ? repo.issues.find((entry) => entry.number === parsed.number)
        : undefined;
      const body = typeof input.body === 'string' ? input.body : '';
      if (!repo || !issue || body === '') {
        ctx.errors.push({ message: 'Could not resolve subjectId to an issue.' });
        return selections ? executeSelectionSet({ __kind: 'Payload', fields: { commentEdge: null } }, selections, ctx) : null;
      }
      const comment = { id: repo.nextComment++, body, createdSeq: issue.comments.length + 1 };
      issue.comments.push(comment);
      const commentNode: Node = { __kind: 'Comment', repo, issue, id: comment.id, body };
      const edge: Node = { __kind: 'CommentEdge', node: commentNode };
      const payload: Node = { __kind: 'Payload', fields: { commentEdge: edge } };
      return selections ? executeSelectionSet(payload, selections, ctx) : payload;
    }
    default:
      return unknownField(ctx, 'Mutation', field);
  }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export interface GraphQLReply {
  status: number;
  body: unknown;
}

function executeOne(
  store: ForgeStore,
  query: string,
  variables: Record<string, unknown>,
  operationName: string | null,
): Record<string, unknown> {
  let definitions: DefinitionNode[];
  try {
    definitions = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const fragments = new Map<string, FragmentNode>();
  for (const definition of definitions) {
    if (definition.kind === 'fragment') fragments.set(definition.name, definition);
  }
  const operations = definitions.filter((definition): definition is OperationNode => definition.kind === 'operation');
  let operation = operations[0];
  if (operationName !== null) {
    operation = operations.find((entry) => entry.name === operationName) ?? operations[0];
  }
  if (!operation) return { data: null, errors: [{ message: 'No operation provided.' }] };
  const ctx: Ctx = { store, errors: [], variables, fragments };
  const root: Node = operation.operation === 'mutation' ? { __kind: 'Mutation' } : { __kind: 'Query' };
  const data = executeSelectionSet(root, operation.selections, ctx);
  const reply: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) reply.errors = ctx.errors;
  return reply;
}

/**
 * Handle a POST /api/graphql body: one operation object or an array of them
 * (GitHub's operation batching, answered in order).
 */
export function handleGraphQL(store: ForgeStore, body: unknown): GraphQLReply {
  if (Array.isArray(body)) {
    const replies = body.map((entry) => {
      if (entry === null || typeof entry !== 'object') return { data: null, errors: [{ message: 'Invalid operation.' }] };
      const record = entry as Record<string, unknown>;
      return executeOne(
        store,
        typeof record.query === 'string' ? record.query : '',
        (record.variables ?? {}) as Record<string, unknown>,
        typeof record.operationName === 'string' ? record.operationName : null,
      );
    });
    return { status: 200, body: replies };
  }
  if (body === null || typeof body !== 'object') {
    return { status: 400, body: { errors: [{ message: 'Request body must be a JSON object or array.' }] } };
  }
  const record = body as Record<string, unknown>;
  const reply = executeOne(
    store,
    typeof record.query === 'string' ? record.query : '',
    (record.variables ?? {}) as Record<string, unknown>,
    typeof record.operationName === 'string' ? record.operationName : null,
  );
  return { status: 200, body: reply };
}
