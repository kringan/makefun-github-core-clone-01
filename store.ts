// The forge's in-memory store: repositories, refs, git objects, issues,
// pull requests, labels and comments. One process, one trial: everything
// lives in maps, and every id is deterministic across live and replay runs.
//
// Server-made commits carry one fixed timestamp, so a replay that repeats the
// same requests reaches the same object ids; client-pushed commits keep the
// identity and timestamp the client wrote into them.

import {
  buildCommitBytes,
  buildTreeBytes,
  hashGitObject,
  isAncestor,
  parseCommitBytes,
  parseTreeBytes,
  reachableObjects,
  treeSortKey,
  ZERO_ID,
  type GitKind,
  type GitObject,
} from './git.ts';

// ---------------------------------------------------------------------------
// identities
// ---------------------------------------------------------------------------

export interface UserView {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** The login the trial's bearer <redacted> names (the kit's fixed scenario seed). */
export const VIEWER: UserView = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

/** Fixed timestamp for server-made commits: deterministic across replays. */
export const SERVER_EPOCH = 1760000000;
export const SERVER_DATE_ISO = '2025-10-09T08:26:40Z';

export function serverIdentity(): string {
  return `${VIEWER.name} <${VIEWER.email}> ${SERVER_EPOCH} +0000`;
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  createdSeq: number;
  updatedSeq: number;
}

export interface PullHead {
  ref: string;
  sha: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: PullHead;
  base: PullHead;
  createdSeq: number;
  updatedSeq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  nextIssue: number;
  nextPull: number;
  nextComment: number;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

// ---------------------------------------------------------------------------
// global ids (opaque, stable across reads)
// ---------------------------------------------------------------------------

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

export class ForgeStore {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private seq = 1;

  nextSeq(): number {
    return this.seq++;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdSeq: this.nextSeq(),
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  // -------------------------------------------------------------------------
  // git objects
  // -------------------------------------------------------------------------

  putObject(repo: Repo, type: GitKind, data: Buffer): string {
    const oid = hashGitObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    const oid = repo.refs.get(ref);
    return oid === ZERO_ID ? undefined : oid;
  }

  /** The tip of a branch name, or of the default branch when no name is given. */
  branchTip(repo: Repo, branch?: string): string | undefined {
    const name = branch ?? repo.defaultBranch;
    return this.refTip(repo, `refs/heads/${name}`);
  }

  commitOf(repo: Repo, oid: string): ReturnType<typeof parseCommitBytes> | null {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    return parseCommitBytes(object.data);
  }

  /** A commit's reachable file map: path -> { oid, mode }. */
  treeFiles(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
    const files = new Map<string, { oid: string; mode: string }>();
    const commit = this.commitOf(repo, commitOid);
    if (!commit) return files;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return;
      for (const item of parseTreeBytes(tree.data)) {
        const path = prefix === '' ? item.name : `${prefix}/${item.name}`;
        if (item.mode === '40000') walk(item.oid, path);
        else files.set(path, { oid: item.oid, mode: item.mode });
      }
    };
    walk(commit.tree, '');
    return files;
  }

  /** Build (and store) the tree for a file map, bottom-up. */
  buildTreeForFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const makeNode = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = makeNode();
    for (const [path, file] of files) {
      const parts = path.split('/');
      let node = root;
      for (let index = 0; index < parts.length - 1; index += 1) {
        const part = parts[index];
        if (!node.dirs.has(part)) node.dirs.set(part, makeNode());
        node = node.dirs.get(part) as Node;
      }
      node.files.set(parts[parts.length - 1], file);
    }
    const build = (node: Node): string => {
      const entries: { mode: string; name: string; oid: string }[] = [];
      for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      entries.sort((a, b) => {
        const ka = treeSortKey(a.mode, a.name);
        const kb = treeSortKey(b.mode, b.name);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
      return this.putObject(repo, 'tree', buildTreeBytes(entries));
    };
    return build(root);
  }

  /** Store a commit and return its id. */
  makeCommit(
    repo: Repo,
    treeOid: string,
    parents: string[],
    message: string,
    author?: string,
  ): string {
    const identity = author ?? serverIdentity();
    const data = buildCommitBytes({
      tree: treeOid,
      parents,
      author: identity,
      committer: identity,
      message,
    });
    return this.putObject(repo, 'commit', data);
  }

  /**
   * Write one file on a branch: new blob, new trees, new commit, ref moved.
   * Returns the new commit id and the blob id.
   */
  writeFileOnBranch(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitOid: string; blobOid: string } {
    const tip = this.branchTip(repo, branch);
    const files = tip ? this.treeFiles(repo, tip) : new Map<string, { oid: string; mode: string }>();
    const blobOid = this.putObject(repo, 'blob', content);
    files.set(path, { oid: blobOid, mode: '100644' });
    const treeOid = this.buildTreeForFiles(repo, files);
    const parents = tip ? [tip] : [];
    const commitOid = this.makeCommit(repo, treeOid, parents, message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return { commitOid, blobOid };
  }

  /** Delete one file from a branch; returns the new commit id, or null when absent. */
  deleteFileOnBranch(
    repo: Repo,
    branch: string,
    path: string,
    message: string,
  ): string | null {
    const tip = this.branchTip(repo, branch);
    if (!tip) return null;
    const files = this.treeFiles(repo, tip);
    if (!files.has(path)) return null;
    files.delete(path);
    const treeOid = this.buildTreeForFiles(repo, files);
    const commitOid = this.makeCommit(repo, treeOid, [tip], message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return commitOid;
  }

  /** Commits reachable from `tip`, newest first (parents in stored order). */
  commitHistory(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.commitOf(repo, oid);
      if (!commit) continue;
      out.push(oid);
      for (let index = commit.parents.length - 1; index >= 0; index -= 1) {
        stack.push(commit.parents[index]);
      }
    }
    return out;
  }

  /** The merge base of two commits: the first common ancestor found walking `b`. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    if (a === b) return a;
    const lookup = this.lookup(repo);
    // Fast paths for linear histories: one side is the ancestor of the other.
    if (isAncestor(a, b, lookup)) return a;
    if (isAncestor(b, a, lookup)) return b;
    const ancestorsA = reachableObjects([a], lookup);
    const stack = [b];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsA.has(oid)) return oid;
      const commit = this.commitOf(repo, oid);
      if (!commit) continue;
      for (const parent of commit.parents) stack.push(parent);
    }
    return null;
  }

  /** Diff two file maps into per-file changes with line counts. */
  diffFileMaps(
    before: Map<string, { oid: string; mode: string }>,
    after: Map<string, { oid: string; mode: string }>,
    readBlob: (oid: string) => Buffer | undefined,
  ): FileChange[] {
    const changes: FileChange[] = [];
    const paths = new Set([...before.keys(), ...after.keys()]);
    for (const path of [...paths].sort()) {
      const oldFile = before.get(path);
      const newFile = after.get(path);
      if (oldFile && !newFile) {
        const lines = countLines(readBlob(oldFile.oid));
        changes.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (!oldFile && newFile) {
        const lines = countLines(readBlob(newFile.oid));
        changes.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (oldFile && newFile && oldFile.oid !== newFile.oid) {
        const [added, removed] = diffLineCounts(readBlob(oldFile.oid), readBlob(newFile.oid));
        changes.push({ filename: path, status: 'modified', additions: added, deletions: removed, changes: added + removed });
      }
    }
    return changes;
  }

  /** The changed files between a pull request's base tip and head tip. */
  pullFiles(repo: Repo, pull: PullRequest): FileChange[] {
    const baseFiles = this.treeFiles(repo, pull.base.sha);
    const headFiles = this.treeFiles(repo, pull.head.sha);
    const readBlob = (oid: string): Buffer | undefined => {
      const object = repo.objects.get(oid);
      return object?.type === 'blob' ? object.data : undefined;
    };
    return this.diffFileMaps(baseFiles, headFiles, readBlob);
  }

  /**
   * Whether a squash merge of `pull` would conflict: a path the base branch
   * changed since the merge base AND the head branch changed differently.
   * The base tip is resolved live: the branch may have moved since the pull
   * request was opened (a merge of a sibling pull request is the classic
   * case), and a stale recorded base would hide the conflict.
   */
  pullConflicts(repo: Repo, pull: PullRequest): boolean {
    const baseTip = this.branchTip(repo, pull.base.ref) ?? pull.base.sha;
    const base = this.mergeBase(repo, baseTip, pull.head.sha);
    if (!base) return false;
    const baseFiles = this.treeFiles(repo, base);
    const oursFiles = this.treeFiles(repo, baseTip);
    const theirsFiles = this.treeFiles(repo, pull.head.sha);
    const paths = new Set([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
    for (const path of paths) {
      const b = baseFiles.get(path)?.oid;
      const o = oursFiles.get(path)?.oid;
      const t = theirsFiles.get(path)?.oid;
      if (o !== b && t !== b && o !== t) return true;
    }
    return false;
  }

  /**
   * Squash-merge a pull request onto its base branch: one new commit carrying
   * the head tip's tree, parented on the base tip. Returns the merge commit
   * id, or null when the pull conflicts.
   */
  squashMerge(repo: Repo, pull: PullRequest): string | null {
    if (this.pullConflicts(repo, pull)) return null;
    const headCommit = this.commitOf(repo, pull.head.sha);
    if (!headCommit) return null;
    const baseTip = this.branchTip(repo, pull.base.ref) ?? pull.base.sha;
    const message = `Merge pull request #${pull.number} from ${pull.head.ref}`;
    const commitOid = this.makeCommit(repo, headCommit.tree, [baseTip], message);
    repo.refs.set(`refs/heads/${pull.base.ref}`, commitOid);
    pull.base.sha = commitOid;
    return commitOid;
  }

  /** True when `newOid` is a fast-forward from `oldOid` (or a fresh create). */
  fastForward(repo: Repo, oldOid: string, newOid: string): boolean {
    if (oldOid === ZERO_ID) return true;
    if (newOid === oldOid) return true;
    return isAncestor(oldOid, newOid, this.lookup(repo));
  }
}

/** Count the lines in a blob (a trailing newline does not make an extra line). */
export function countLines(data: Buffer | undefined): number {
  if (!data || data.length === 0) return 0;
  const text = data.toString('utf8');
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

/** Added/removed line counts between two blobs, by multiset line difference. */
export function diffLineCounts(oldData: Buffer | undefined, newData: Buffer | undefined): [number, number] {
  const oldLines = oldData ? oldData.toString('utf8').split('\n') : [];
  const newLines = newData ? newData.toString('utf8').split('\n') : [];
  if (oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines[newLines.length - 1] === '') newLines.pop();
  const oldCount = new Map<string, number>();
  for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
  const newCount = new Map<string, number>();
  for (const line of newLines) newCount.set(line, (newCount.get(line) ?? 0) + 1);
  let added = 0;
  let removed = 0;
  for (const [line, count] of newCount) {
    const gone = Math.max(0, count - (oldCount.get(line) ?? 0));
    added += gone;
  }
  for (const [line, count] of oldCount) {
    const gone = Math.max(0, count - (newCount.get(line) ?? 0));
    removed += gone;
  }
  return [added, removed];
}
