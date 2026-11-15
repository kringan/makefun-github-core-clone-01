// GitHub REST v3 surface: repositories, branches, commits, contents, labels,
// issues, comments and pull requests, over the forge's in-memory store.
//
// Every reply is JSON with an X-GitHub-Request-Id. A repository belongs to
// the login the bearer <redacted> names, so the same name under another owner is a
// 404, never a 403. A missing or wrong token is a 401 (enforced in app.ts).

import {
  ForgeStore,
  SERVER_DATE_ISO,
  VIEWER,
  globalId,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { parseCommitBytes } from './git.ts';

export interface HttpRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  bodyText: string;
  host: string;
}

export interface HttpReply {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

export type Json = Record<string, unknown>;

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

function ok(status: number, body: unknown, headers?: Record<string, string>): HttpReply {
  return { status, headers, body };
}

function err(status: number, message: string): HttpReply {
  return { status, body: { message } };
}

function parseBody(req: HttpRequest): { data: Json | null; bad: boolean } {
  if (req.bodyText === '') return { data: null, bad: false };
  try {
    const parsed = JSON.parse(req.bodyText) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { data: parsed as Json, bad: false };
    }
    return { data: null, bad: false };
  } catch {
    return { data: null, bad: true };
  }
}

/** Split /a/b/c into segments, decoding each one. */
export function splitPath(path: string): string[] {
  return path
    .split('/')
    .filter((part) => part !== '')
    .map((part) => decodeURIComponent(part));
}

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

function userJson(login: string, id: number): Json {
  return {
    login,
    id,
    node_id: globalId('User', login),
    avatar_url: '',
    html_url: `https://github.com/${login}`,
    type: 'User',
    site_admin: false,
  };
}

function repoJson(repo: Repo): Json {
  return {
    id: repo.id,
    node_id: globalId('Repository', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, repo.owner === VIEWER.login ? VIEWER.id : 1001),
    private: repo.isPrivate,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: SERVER_DATE_ISO,
    updated_at: SERVER_DATE_ISO,
    pushed_at: SERVER_DATE_ISO,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function labelJson(label: { name: string; color: string }): Json {
  return {
    id: Math.abs(hashString(label.name)) % 1000000 + 1,
    node_id: globalId('Label', label.name),
    name: label.name,
    color: label.color,
    description: '',
    default: false,
  };
}

function hashString(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  return hash;
}

function issueJson(repo: Repo, issue: Issue): Json {
  return {
    id: repo.id * 1000000 + issue.number,
    node_id: globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((label) => labelJson(label)),
    user: userJson(VIEWER.login, VIEWER.id),
    assignees: [],
    created_at: SERVER_DATE_ISO,
    updated_at: SERVER_DATE_ISO,
    closed_at: issue.state === 'closed' ? SERVER_DATE_ISO : null,
    comments: issue.comments.length,
  };
}

function pullJson(repo: Repo, pull: PullRequest): Json {
  return {
    id: repo.id * 1000000 + pull.number,
    node_id: globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    head: {
      label: `${repo.owner}:${pull.head.ref}`,
      ref: pull.head.ref,
      sha: pull.head.sha,
      user: userJson(repo.owner, VIEWER.id),
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${pull.base.ref}`,
      ref: pull.base.ref,
      sha: pull.base.sha,
      user: userJson(repo.owner, VIEWER.id),
      repo: repoJson(repo),
    },
    merged: pull.merged,
    mergeable: null,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    created_at: SERVER_DATE_ISO,
    updated_at: SERVER_DATE_ISO,
    closed_at: pull.state === 'closed' ? SERVER_DATE_ISO : null,
  };
}

function commitJson(repo: Repo, sha: string): Json | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommitBytes(object.data);
  const authorOf = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (!match) return { name: line, email: '', date: SERVER_DATE_ISO };
    const epoch = Number.parseInt(match[3], 10) * 1000;
    return { name: match[1], email: match[2], date: new Date(epoch).toISOString() };
  };
  const author = authorOf(commit.author);
  const committer = authorOf(commit.committer);
  // A commit object stores its message with a trailing newline; the API
  // answers the message without it.
  const message = commit.message.replace(/\n+$/, '');
  return {
    sha,
    node_id: globalId('Commit', sha),
    commit: {
      message,
      author,
      committer,
      tree: { sha: commit.tree },
    },
    author: userJson(VIEWER.login, VIEWER.id),
    committer: userJson(VIEWER.login, VIEWER.id),
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

function paginate<T>(items: readonly T[], req: HttpRequest): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Number.parseInt(req.query.get('per_page') ?? '30', 10) || 30);
  const page = Math.max(1, Number.parseInt(req.query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const url = new URL(`http://${req.host}${req.path}`);
    for (const [key, value] of req.query) {
      if (key !== 'page') url.searchParams.set(key, value);
    }
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page + 1));
    link = `<${url.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}

function pageHeaders(link: string | null): Record<string, string> {
  return link ? { link } : {};
}

// ---------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------

export function handleRest(store: ForgeStore, req: HttpRequest): HttpReply | null {
  const segments = splitPath(req.path);
  // /api/v3/...
  if (segments.length < 2 || segments[0] !== 'api' || segments[1] !== 'v3') return null;
  const rest = segments.slice(2);
  const { data: body, bad } = parseBody(req);
  if (bad) return err(400, 'Problems parsing JSON');
  const method = req.method;

  // GET /api/v3/ — the API root.
  if (rest.length === 0) {
    if (method === 'GET') {
      return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, {
        'x-oauth-scopes': 'repo, read:org',
      });
    }
    return err(404, 'Not Found');
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method === 'GET') return ok(200, { installed_version: '1.0.0' });
    return err(404, 'Not Found');
  }

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user') {
    if (method === 'GET') {
      return ok(200, {
        ...userJson(VIEWER.login, VIEWER.id),
        name: VIEWER.name,
        email: VIEWER.email,
      });
    }
    return err(404, 'Not Found');
  }

  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const repos = store.listRepos(VIEWER.login);
      const { page, link } = paginate(repos, req);
      return ok(200, page.map((repo) => repoJson(repo)), pageHeaders(link));
    }
    if (method === 'POST') {
      const name = typeof body?.name === 'string' ? body.name : '';
      if (name === '' || /[^\w.-]/.test(name)) return err(422, 'Invalid repository name');
      if (store.getRepo(VIEWER.login, name)) return err(422, 'name already exists on this account');
      const repo = store.createRepo(
        VIEWER.login,
        name,
        typeof body?.description === 'string' ? (body.description as string) : '',
        body?.private === true,
      );
      return ok(201, repoJson(repo));
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1];
    const name = rest[2];
    if (owner !== VIEWER.login) return err(404, 'Not Found');
    const repo = store.getRepo(owner, name);
    if (!repo) return err(404, 'Not Found');
    return handleRepo(store, repo, rest.slice(3), req, body);
  }

  return err(404, 'Not Found');
}

function handleRepo(
  store: ForgeStore,
  repo: Repo,
  tail: string[],
  req: HttpRequest,
  body: Json | null,
): HttpReply {
  const method = req.method;

  // GET/PATCH/DELETE /repos/{o}/{r}
  if (tail.length === 0) {
    if (method === 'GET') return ok(200, repoJson(repo));
    if (method === 'PATCH') {
      if (typeof body?.description === 'string') repo.description = body.description as string;
      return ok(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      return { status: 204, body: '' };
    }
    return err(404, 'Not Found');
  }

  const section = tail[0];

  if (section === 'branches') {
    if (method === 'GET' && tail.length === 1) {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .sort()
        .map((ref) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha: repo.refs.get(ref) },
          protected: false,
        }));
      return ok(200, branches);
    }
    if (method === 'GET' && tail.length === 2) {
      const tip = repo.refs.get(`refs/heads/${tail[1]}`);
      if (!tip) return err(404, 'Not Found');
      return ok(200, { name: tail[1], commit: { sha: tip }, protected: false });
    }
    return err(404, 'Not Found');
  }

  if (section === 'commits') {
    if (method === 'GET' && tail.length === 1) {
      const ref = req.query.get('sha') ?? repo.defaultBranch;
      let tip = repo.refs.get(`refs/heads/${ref}`);
      if (!tip && repo.objects.has(ref)) tip = ref;
      if (!tip) return err(404, 'Not Found');
      const history = store.commitHistory(repo, tip);
      const { page, link } = paginate(history, req);
      const out: Json[] = [];
      for (const sha of page) {
        const entry = commitJson(repo, sha);
        if (entry) out.push(entry);
      }
      return ok(200, out, pageHeaders(link));
    }
    return err(404, 'Not Found');
  }

  if (section === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const ref = typeof body?.ref === 'string' ? (body.ref as string) : '';
      const sha = typeof body?.sha === 'string' ? (body.sha as string) : '';
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) return err(422, 'Invalid ref or object');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return ok(201, { ref, node_id: globalId('Ref', ref), object: { sha, type: 'commit' } });
    }
    if (method === 'GET') {
      if (tail.length === 2) {
        const refs = [...repo.refs.keys()].sort().map((ref) => ({
          ref,
          node_id: globalId('Ref', ref),
          object: { sha: repo.refs.get(ref), type: 'commit' },
        }));
        return ok(200, refs);
      }
      const refName = `refs/${tail.slice(2).join('/')}`;
      const tip = repo.refs.get(refName);
      if (!tip) return err(404, 'Not Found');
      return ok(200, { ref: refName, node_id: globalId('Ref', refName), object: { sha: tip, type: 'commit' } });
    }
    return err(404, 'Not Found');
  }

  if (section === 'contents') {
    return handleContents(store, repo, tail.slice(1), req, body);
  }

  if (section === 'labels') {
    if (method === 'GET' && tail.length === 1) {
      return ok(200, [...repo.labels.values()].map((label) => labelJson(label)));
    }
    if (method === 'POST' && tail.length === 1) {
      const name = typeof body?.name === 'string' ? (body.name as string) : '';
      if (name === '') return err(422, 'Label name is required');
      const color = typeof body?.color === 'string' ? (body.color as string) : 'ededed';
      const existing = repo.labels.get(name);
      if (existing) return ok(201, labelJson(existing));
      const label = { name, color };
      repo.labels.set(name, label);
      return ok(201, labelJson(label));
    }
    return err(404, 'Not Found');
  }

  if (section === 'issues') {
    return handleIssues(repo, tail.slice(1), req, body);
  }

  if (section === 'pulls') {
    return handlePulls(store, repo, tail.slice(1), req, body);
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

function handleContents(
  store: ForgeStore,
  repo: Repo,
  tail: string[],
  req: HttpRequest,
  body: Json | null,
): HttpReply {
  const method = req.method;
  const path = tail.join('/');
  if (path === '') return err(404, 'Not Found');
  const branch = typeof body?.branch === 'string'
    ? (body.branch as string)
    : (req.query.get('ref') ?? repo.defaultBranch);
  const tip = store.branchTip(repo, branch);

  if (method === 'GET') {
    if (!tip) return err(404, 'Not Found');
    const files = store.treeFiles(repo, tip);
    const direct = files.get(path);
    if (direct) {
      const object = repo.objects.get(direct.oid);
      const content = object?.data ?? Buffer.alloc(0);
      return ok(200, {
        type: 'file',
        encoding: 'base64',
        size: content.length,
        name: path.split('/').pop(),
        path,
        content: content.toString('base64'),
        sha: direct.oid,
      });
    }
    // Directory listing: direct children of `path`.
    const prefix = `${path}/`;
    const children = new Map<string, { type: string; sha: string; size: number }>();
    for (const [filePath, file] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        const object = repo.objects.get(file.oid);
        children.set(rest, { type: 'file', sha: file.oid, size: object?.data.length ?? 0 });
      } else {
        const dir = rest.slice(0, slash);
        if (!children.has(dir)) children.set(dir, { type: 'dir', sha: '', size: 0 });
      }
    }
    if (children.size === 0) return err(404, 'Not Found');
    const out = [...children.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, child]) => ({
        type: child.type,
        name,
        path: `${path}/${name}`,
        sha: child.sha,
        size: child.size,
      }));
    return ok(200, out);
  }

  if (method === 'PUT') {
    const message = typeof body?.message === 'string' ? (body.message as string) : 'Update file';
    const encoded = typeof body?.content === 'string' ? (body.content as string) : '';
    if (encoded === '') return err(422, 'content is required');
    const content = Buffer.from(encoded.replace(/[\r\n\t ]+/g, ''), 'base64');
    const files = tip ? store.treeFiles(repo, tip) : new Map();
    const existing = files.get(path);
    const sha = typeof body?.sha === 'string' ? (body.sha as string) : undefined;
    if (existing) {
      if (sha !== undefined && sha !== existing.oid) return err(409, 'sha does not match');
      if (sha === undefined) return err(409, 'sha is required to update a file');
    }
    const { commitOid, blobOid } = store.writeFileOnBranch(repo, branch, path, content, message);
    return ok(existing ? 200 : 201, {
      content: {
        name: path.split('/').pop(),
        path,
        sha: blobOid,
        size: content.length,
        type: 'file',
        encoding: 'base64',
        content: encoded,
      },
      commit: { sha: commitOid, message },
    });
  }

  if (method === 'DELETE') {
    const message = typeof body?.message === 'string' ? (body.message as string) : 'Delete file';
    const sha = typeof body?.sha === 'string' ? (body.sha as string) : undefined;
    const files = tip ? store.treeFiles(repo, tip) : new Map();
    const existing = files.get(path);
    if (!existing) return err(404, 'Not Found');
    if (sha !== undefined && sha !== existing.oid) return err(409, 'sha does not match');
    const commitOid = store.deleteFileOnBranch(repo, branch, path, message);
    if (!commitOid) return err(404, 'Not Found');
    return ok(200, { commit: { sha: commitOid, message } });
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

function handleIssues(repo: Repo, tail: string[], req: HttpRequest, body: Json | null): HttpReply {
  const method = req.method;

  if (tail.length === 0) {
    if (method === 'POST') {
      const title = typeof body?.title === 'string' ? (body.title as string) : '';
      if (title === '') return err(422, 'title is required');
      const labelNames = Array.isArray(body?.labels)
        ? (body.labels as unknown[]).map((label) => String(label))
        : [];
      const labels: { name: string; color: string }[] = [];
      for (const name of labelNames) {
        const label = repo.labels.get(name);
        if (!label) return err(422, `Label '${name}' does not exist`);
        labels.push(label);
      }
      const issue: Issue = {
        number: repo.nextIssue++,
        title,
        body: typeof body?.body === 'string' ? (body.body as string) : '',
        state: 'open',
        labels,
        comments: [],
        createdSeq: repo.issues.length + 1,
        updatedSeq: repo.issues.length + 1,
      };
      issue.createdSeq = issue.number;
      issue.updatedSeq = issue.number;
      repo.issues.push(issue);
      return ok(201, issueJson(repo, issue));
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      if (sort === 'created') {
        list = [...list].sort((a, b) =>
          direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq,
        );
      }
      const { page, link } = paginate(list, req);
      return ok(200, page.map((issue) => issueJson(repo, issue)), pageHeaders(link));
    }
    return err(404, 'Not Found');
  }

  const number = Number.parseInt(tail[0], 10);
  if (!Number.isInteger(number)) return err(404, 'Not Found');
  const issue = repo.issues.find((entry) => entry.number === number);
  if (!issue) return err(404, 'Not Found');

  if (tail.length === 1) {
    if (method === 'GET') return ok(200, issueJson(repo, issue));
    if (method === 'PATCH') {
      if (body?.state === 'open' || body?.state === 'closed') issue.state = body.state;
      if (typeof body?.title === 'string') issue.title = body.title as string;
      if (typeof body?.body === 'string') issue.body = body.body as string;
      return ok(200, issueJson(repo, issue));
    }
    return err(404, 'Not Found');
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'GET') {
      return ok(200, issue.comments.map((comment) => ({
        id: repo.id * 1000000 + comment.id,
        node_id: globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}:${comment.id}`),
        body: comment.body,
        user: userJson(VIEWER.login, VIEWER.id),
        created_at: SERVER_DATE_ISO,
        updated_at: SERVER_DATE_ISO,
      })));
    }
    if (method === 'POST') {
      const text = typeof body?.body === 'string' ? (body.body as string) : '';
      if (text === '') return err(422, 'body is required');
      const comment = { id: repo.nextComment++, body: text, createdSeq: issue.comments.length + 1 };
      issue.comments.push(comment);
      return ok(201, {
        id: repo.id * 1000000 + comment.id,
        node_id: globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}:${comment.id}`),
        body: text,
        user: userJson(VIEWER.login, VIEWER.id),
        created_at: SERVER_DATE_ISO,
        updated_at: SERVER_DATE_ISO,
      });
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------

function handlePulls(
  store: ForgeStore,
  repo: Repo,
  tail: string[],
  req: HttpRequest,
  body: Json | null,
): HttpReply {
  const method = req.method;

  if (tail.length === 0) {
    if (method === 'POST') {
      const title = typeof body?.title === 'string' ? (body.title as string) : '';
      const headRef = typeof body?.head === 'string' ? (body.head as string) : '';
      const baseRef = typeof body?.base === 'string' ? (body.base as string) : '';
      if (title === '' || headRef === '' || baseRef === '') return err(422, 'title, head and base are required');
      const headSha = store.branchTip(repo, headRef);
      const baseSha = store.branchTip(repo, baseRef);
      if (!headSha || !baseSha) return err(422, 'head or base branch does not exist');
      const pull: PullRequest = {
        number: repo.nextPull++,
        title,
        body: typeof body?.body === 'string' ? (body.body as string) : '',
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
      return ok(201, pullJson(repo, pull));
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      const { page, link } = paginate(list, req);
      return ok(200, page.map((pull) => pullJson(repo, pull)), pageHeaders(link));
    }
    return err(404, 'Not Found');
  }

  const number = Number.parseInt(tail[0], 10);
  if (!Number.isInteger(number)) return err(404, 'Not Found');
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (!pull) return err(404, 'Not Found');

  if (tail.length === 1) {
    if (method === 'GET') return ok(200, pullJson(repo, pull));
    return err(404, 'Not Found');
  }

  if (tail.length === 2 && tail[1] === 'files') {
    if (method === 'GET') {
      const files = store.pullFiles(repo, pull).map((change) => ({
        sha: '',
        filename: change.filename,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.changes,
        blob_url: '',
        raw_url: '',
        contents_url: '',
        patch: '',
      }));
      return ok(200, files);
    }
    return err(404, 'Not Found');
  }

  if (tail.length === 2 && tail[1] === 'merge') {
    if (method === 'PUT') {
      if (pull.merged || pull.state === 'closed') return err(405, 'Pull request is already merged or closed');
      if (store.pullConflicts(repo, pull)) return err(405, 'Merge conflict');
      const mergeSha = store.squashMerge(repo, pull);
      if (!mergeSha) return err(405, 'Merge conflict');
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = SERVER_DATE_ISO;
      pull.mergeCommitSha = mergeSha;
      return ok(200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
