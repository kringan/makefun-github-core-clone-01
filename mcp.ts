// MCP over Streamable HTTP: JSON-RPC 2.0 at POST /mcp. Modern era first —
// `server/discover` answers identity, capabilities and supported revisions in
// one request — with the legacy `initialize` handshake kept as a fallback.
//
// Six tools, all against the same in-memory store the REST and GraphQL
// surfaces use, so a repository or issue made over MCP is the same object
// over REST. `tools/list` is a fixed constant, byte-identical on every call.

import {
  ForgeStore,
  SERVER_DATE_ISO,
  VIEWER,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpReply {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: SERVER_DATE_ISO,
    updated_at: SERVER_DATE_ISO,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 1000000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => label.name),
    comments: issue.comments.length,
    created_at: SERVER_DATE_ISO,
    updated_at: SERVER_DATE_ISO,
  };
}

function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: repo.id * 1000000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.head.ref, sha: pull.head.sha },
    base: { ref: pull.base.ref, sha: pull.base.sha },
    merge_commit_sha: pull.mergeCommitSha,
    created_at: SERVER_DATE_ISO,
    updated_at: SERVER_DATE_ISO,
  };
}

function textResult(data: unknown, isError = false): Record<string, unknown> {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return {
    content: [{ type: 'text', text }],
    structuredContent: typeof data === 'string' ? { message: data } : data,
    isError,
  };
}

function errorResult(text: string): Record<string, unknown> {
  return textResult(text, true);
}

function resolveRepo(store: ForgeStore, args: Record<string, unknown>): Repo | null {
  // A full_name property receives "owner/repo".
  const fullName = typeof args.full_name === 'string' ? args.full_name : null;
  if (fullName) {
    const [owner, name] = fullName.split('/');
    if (owner && name) return store.getRepo(owner, name);
    return null;
  }
  const owner = typeof args.owner === 'string' ? args.owner : null;
  const name = typeof args.repo === 'string' ? args.repo : null;
  if (!owner || !name) return null;
  return store.getRepo(owner, name);
}

function callTool(store: ForgeStore, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (repoName === '') return errorResult('Missing required argument: name');
      if (store.getRepo(VIEWER.login, repoName)) return errorResult(`Repository ${VIEWER.login}/${repoName} already exists`);
      const repo = store.createRepo(
        VIEWER.login,
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return textResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = resolveRepo(store, args);
      if (!repo) return errorResult('Repository not found');
      return textResult(repoJson(repo));
    }
    case 'create_issue': {
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') return errorResult('Missing required argument: title');
      const repo = resolveRepo(store, args);
      if (!repo) return errorResult('Repository not found');
      const issue: Issue = {
        number: repo.nextIssue++,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: repo.nextIssue,
        updatedSeq: repo.nextIssue,
      };
      repo.issues.push(issue);
      return textResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = resolveRepo(store, args);
      if (!repo) return errorResult('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return textResult({ issues: list.map((issue) => issueJson(repo, issue)) });
    }
    case 'create_pull_request': {
      const title = typeof args.title === 'string' ? args.title : '';
      const headRef = typeof args.head === 'string' ? args.head : '';
      const baseRef = typeof args.base === 'string' ? args.base : '';
      if (title === '' || headRef === '' || baseRef === '') {
        return errorResult('Missing required argument: title, head or base');
      }
      const repo = resolveRepo(store, args);
      if (!repo) return errorResult('Repository not found');
      const headSha = store.branchTip(repo, headRef);
      const baseSha = store.branchTip(repo, baseRef);
      if (!headSha || !baseSha) return errorResult('head or base branch does not exist');
      const pull: PullRequest = {
        number: repo.nextPull++,
        title,
        body: typeof args.body === 'string' ? args.body : '',
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
      return textResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const number = typeof args.pull_number === 'number'
        ? args.pull_number
        : typeof args.pull_number === 'string' ? Number.parseInt(args.pull_number, 10) : NaN;
      if (!Number.isInteger(number)) return errorResult('Missing required argument: pull_number');
      const repo = resolveRepo(store, args);
      if (!repo) return errorResult('Repository not found');
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (!pull) return errorResult('Pull request not found');
      if (pull.merged || pull.state === 'closed') return errorResult('Pull request is already merged or closed');
      const mergeSha = store.squashMerge(repo, pull);
      if (!mergeSha) return errorResult('Merge conflict');
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = SERVER_DATE_ISO;
      pull.mergeCommitSha = mergeSha;
      return textResult(pullJson(repo, pull));
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Handle one parsed JSON-RPC request object. A notification (no id) answers
 * with a 202 and an empty body.
 */
export function handleMcp(store: ForgeStore, request: unknown): McpReply {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const req = request as JsonRpcRequest;
  const id = req.id === undefined ? null : req.id;
  const isNotification = req.id === undefined;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    const result = {
      supportedVersions: SUPPORTED_VERSIONS,
      protocolVersion: '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    };
    if (isNotification) return { status: 202, body: '' };
    return { status: 200, body: rpcResult(id, result) };
  }

  if (method === 'initialize') {
    const offered = (params.protocolVersion as string | undefined) ?? '2025-11-25';
    const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    const result = {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    };
    if (isNotification) return { status: 202, body: '' };
    return { status: 200, body: rpcResult(id, result) };
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: '' };
  }

  if (method === 'ping') {
    if (isNotification) return { status: 202, body: '' };
    return { status: 200, body: rpcResult(id, {}) };
  }

  if (method === 'tools/list') {
    if (isNotification) return { status: 202, body: '' };
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }

  if (method === 'tools/call') {
    if (isNotification) return { status: 202, body: '' };
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const known = TOOLS.some((tool) => tool.name === toolName);
    if (!known) {
      return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${toolName}`) };
    }
    const result = callTool(store, toolName, args);
    return { status: 200, body: rpcResult(id, result) };
  }

  if (isNotification) return { status: 202, body: '' };
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}
