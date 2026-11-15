// Smart-HTTP handlers: info/refs advertisements (v0 and v2), ls-refs,
// upload-pack fetch (v2 and v0) and receive-pack push. The shapes here follow
// the pkt-line wire the suite's git client speaks: section names as plain
// pkt-lines with no delim packets in a v2 fetch answer, sideband band 1 for
// pack bytes, and a report-status stream for pushes.

import {
  encodePktList,
  hashGitObject,
  isOid,
  parseCommitBytes,
  parseTagBytes,
  parseTreeBytes,
  pktFlush,
  pktLine,
  reachableObjects,
  readPackFile,
  splitPktLines,
  writePackFile,
  ZERO_ID,
  type GitObject,
  type Pkt,
} from './git.ts';
import { ForgeStore, type Repo } from './store.ts';

export const AGENT_NAME = 'forge/1.0';

const SIDEBAND_CHUNK = 32768;

// ---------------------------------------------------------------------------
// ref listing
// ---------------------------------------------------------------------------

export interface ListedRef {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** HEAD plus every branch and tag, sorted the way git lists them. */
export function listRefs(repo: Repo): ListedRef[] {
  const refs: ListedRef[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip && defaultTip !== ZERO_ID) {
    refs.push({ oid: defaultTip, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` });
  } else {
    refs.push({ oid: ZERO_ID, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}`, unborn: true });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    if (oid === ZERO_ID) continue;
    const entry: ListedRef = { oid, name };
    const object = repo.objects.get(oid);
    if (object?.type === 'tag') {
      entry.peeled = parseTagBytes(object.data).object;
    }
    refs.push(entry);
  }
  return refs;
}

function refLine(ref: ListedRef, peel: boolean, symrefs: boolean): string {
  if (ref.unborn) {
    let line = `unborn ${ref.name}`;
    if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    return `${line}\n`;
  }
  let line = `${ref.oid} ${ref.name}`;
  if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
  if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
  return `${line}\n`;
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

function v0Capabilities(service: 'upload' | 'receive', repo: Repo): string {
  const common = ['side-band-64k', 'thin-pack', 'ofs-delta', 'multi_ack', 'shallow', `agent=${AGENT_NAME}`];
  if (service === 'receive') {
    return [...common, 'report-status', 'report-status-v2', 'delete-refs', `symref=HEAD:refs/heads/${repo.defaultBranch}`].join(' ');
  }
  return [...common, `symref=HEAD:refs/heads/${repo.defaultBranch}`].join(' ');
}

function v0Advertisement(repo: Repo, service: 'upload' | 'receive'): Buffer {
  const caps = v0Capabilities(service, repo);
  const refs = listRefs(repo);
  const lines: (string | 'flush')[] = [`# service=git-${service === 'upload' ? 'upload-pack' : 'receive-pack'}\n`, 'flush'];
  if (refs.length === 0) {
    lines.push(`${ZERO_ID} capabilities^{}\0${caps}\n`);
  } else {
    refs.forEach((ref, index) => {
      // A v0 advertisement names an object id on every line: an unborn HEAD
      // is the zero id, never the v2 `unborn <name>` form.
      const line = ref.unborn ? `${ZERO_ID} ${ref.name}\n` : refLine(ref, false, false);
      lines.push(index === 0 ? line.replace(/\n$/, `\0${caps}\n`) : line);
    });
  }
  lines.push('flush');
  return encodePktList(lines);
}

function v2Advertisement(): Buffer {
  const lines: (string | 'flush')[] = [
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `agent=${AGENT_NAME}\n`,
    'flush',
  ];
  return encodePktList(lines);
}

export function infoRefsBody(
  repo: Repo | undefined,
  service: 'git-upload-pack' | 'git-receive-pack',
  wantsV2: boolean,
): { status: number; contentType: string; body: Buffer } {
  if (!repo) {
    return { status: 404, contentType: 'text/plain', body: Buffer.from('Not Found\n', 'utf8') };
  }
  if (service === 'git-upload-pack' && wantsV2) {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
  }
  const kind = service === 'git-upload-pack' ? 'upload' : 'receive';
  return {
    status: 200,
    contentType: `application/x-git-${service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack'}-advertisement`,
    body: v0Advertisement(repo, kind),
  };
}

// ---------------------------------------------------------------------------
// request parsing helpers
// ---------------------------------------------------------------------------

interface ParsedPackets {
  packets: Pkt[];
  /** Byte offset where the pkt-line stream ended (the pack starts here). */
  streamEnd: number;
}

/** Split the leading pkt-line stream of a body; the rest is raw pack bytes. */
function parseLeadingPackets(body: Buffer): ParsedPackets {
  const packets: Pkt[] = [];
  let at = 0;
  while (at < body.length) {
    if (at + 4 > body.length) throw new Error('truncated pkt-line header');
    const head = body.subarray(at, at + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      at += 4;
      break;
    }
    if (head === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (head === '0002') {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    const length = parseInt(head, 16);
    if (!Number.isFinite(length) || length < 4 || at + length > body.length) {
      throw new Error(`bad pkt-line length ${head}`);
    }
    packets.push({ kind: 'data', payload: body.subarray(at + 4, at + length) });
    at += length;
  }
  return { packets, streamEnd: at };
}

function packetText(packet: Pkt): string {
  return packet.kind === 'data' ? packet.payload.toString('utf8') : '';
}

/** Wrap bytes in sideband band-1 packets, chunked under the pkt-line cap. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let at = 0; at < pack.length; at += SIDEBAND_CHUNK) {
    const piece = pack.subarray(at, Math.min(pack.length, at + SIDEBAND_CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), piece]);
    parts.push(pktLine(payload));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/**
 * Walk from `tips` and collect reachable objects. When `stopAt` names a
 * commit, that commit's tree and blobs are included but its parents are not.
 * When `maxDepth` is set, only commits fewer than `maxDepth` generations
 * from a tip are included; `boundary` collects the commits at the cutoff.
 */
function collectWithCutoff(
  repo: Repo,
  tips: Iterable<string>,
  options: { stopAt?: Set<string>; maxDepth?: number },
): { objects: Set<string>; boundary: string[] } {
  const objects = new Set<string>();
  const boundary: string[] = [];
  const seenCommits = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const tip of tips) {
    if (tip !== ZERO_ID && !seenCommits.has(tip)) {
      seenCommits.add(tip);
      queue.push({ oid: tip, depth: 0 });
    }
  }
  const includeTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (objects.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      objects.add(oid);
      if (object.type === 'tree') {
        for (const item of parseTreeBytes(object.data)) stack.push(item.oid);
      }
    }
  };
  while (queue.length > 0) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    const object = repo.objects.get(oid);
    if (!object) continue;
    objects.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommitBytes(object.data);
      includeTree(commit.tree);
      const atCutoff = options.maxDepth !== undefined && depth >= options.maxDepth - 1;
      const stopped = options.stopAt?.has(oid) ?? false;
      if (atCutoff) boundary.push(oid);
      if (!atCutoff && !stopped) {
        for (const parent of commit.parents) {
          if (!seenCommits.has(parent)) {
            seenCommits.add(parent);
            queue.push({ oid: parent, depth: depth + 1 });
          }
        }
      }
    } else if (object.type === 'tree') {
      includeTree(oid);
    } else if (object.type === 'tag') {
      const target = parseTagBytes(object.data).object;
      if (!seenCommits.has(target)) {
        seenCommits.add(target);
        queue.push({ oid: target, depth });
      }
    }
  }
  return { objects, boundary };
}

function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depth: number | null,
): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const oldShallow = new Set(clientShallow.filter((oid) => isOid(oid)));
  // What the client already holds: reachable from its haves, stopping at the
  // old shallow boundary (those commits' parents are not held).
  const held = collectWithCutoff(repo, haves.filter((oid) => repo.objects.has(oid)), {
    stopAt: oldShallow,
  }).objects;
  // What the fetch may deliver: reachable from the wants, cut at the depth.
  const wanted = collectWithCutoff(repo, wants.filter((oid) => repo.objects.has(oid)), {
    maxDepth: depth ?? undefined,
  });
  const send = new Set<string>();
  for (const oid of wanted.objects) {
    if (!held.has(oid)) send.add(oid);
  }
  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  const acks: string[] = [];
  for (const have of haves) {
    if (repo.objects.has(have)) acks.push(have);
  }
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (depth !== null) {
    shallow = wanted.boundary.filter((oid) => send.has(oid) || held.has(oid));
    // An old boundary whose parents are now delivered is no longer shallow.
    for (const old of oldShallow) {
      if (shallow.includes(old)) continue;
      const commit = repo.objects.get(old);
      if (!commit || commit.type !== 'commit') continue;
      const parents = parseCommitBytes(commit.data).parents;
      const delivered = parents.every((parent) => send.has(parent) || held.has(parent));
      if (delivered && (send.has(old) || held.has(old))) unshallow.push(old);
    }
  } else if (oldShallow.size > 0) {
    shallow = [...oldShallow].filter((oid) => repo.objects.has(oid));
  }
  void lookup;
  return { objects, shallow, unshallow, acks };
}

// ---------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------

function handleLsRefs(repo: Repo, packets: Pkt[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packetText(packet).replace(/\n$/, '');
    if (!pastDelim) continue;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: (string | 'flush')[] = [];
  for (const ref of listRefs(repo)) {
    if (!keep(ref.name)) continue;
    if (ref.unborn && !unborn) continue;
    lines.push(refLine(ref, peel, symrefs));
  }
  lines.push('flush');
  return encodePktList(lines);
}

// ---------------------------------------------------------------------------
// fetch (v2)
// ---------------------------------------------------------------------------

function handleFetchV2(repo: Repo, packets: Pkt[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packetText(packet).replace(/\n$/, '');
    if (!pastDelim) continue;
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
  }
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  // The acknowledgments section exists only when the client sent haves:
  // a fresh clone (no haves) goes straight to the packfile, and a real git
  // client dies with "expected 'packfile'" if it sees acknowledgments
  // first. Sections are delim-separated; only the response ends with flush.
  if (haves.length > 0) {
    const ackLines: (string | 'flush' | 'delim')[] = ['acknowledgments\n'];
    if (plan.acks.length === 0) ackLines.push('NAK\n');
    else for (const ack of plan.acks) ackLines.push(`ACK ${ack}\n`);
    ackLines.push('ready\n', 'delim');
    parts.push(encodePktList(ackLines));
  }
  // shallow-info section
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const infoLines: (string | 'flush' | 'delim')[] = ['shallow-info\n'];
    for (const oid of plan.shallow) infoLines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) infoLines.push(`unshallow ${oid}\n`);
    infoLines.push('delim');
    parts.push(encodePktList(infoLines));
  }
  // packfile section, or a bare flush when there is nothing to send.
  if (plan.objects.length > 0) {
    const pack = writePackFile(plan.objects);
    parts.push(encodePktList(['packfile\n']));
    parts.push(sidebandPack(pack));
    parts.push(pktFlush());
  } else {
    parts.push(pktFlush());
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch (v0)
// ---------------------------------------------------------------------------

function handleFetchV0(repo: Repo, packets: Pkt[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packetText(packet).replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
  }
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  const headLines: (string | 'flush')[] = [];
  for (const oid of plan.shallow) headLines.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) headLines.push(`unshallow ${oid}\n`);
  if (plan.acks.length === 0) headLines.push('NAK\n');
  else for (const ack of plan.acks) headLines.push(`ACK ${ack}\n`);
  if (headLines.length > 0) parts.push(encodePktList(headLines));
  if (plan.objects.length > 0) {
    const pack = writePackFile(plan.objects);
    parts.push(sidebandPack(pack));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack entry point
// ---------------------------------------------------------------------------

export function uploadPackBody(
  repo: Repo,
  body: Buffer,
  wantsV2: boolean,
): { status: number; contentType: string; body: Buffer } {
  const { packets } = parseLeadingPackets(body);
  const first = packets.find((packet) => packet.kind === 'data');
  const command = first ? packetText(first).replace(/\n$/, '') : '';
  let out: Buffer;
  if (wantsV2 && command === 'command=ls-refs') {
    out = handleLsRefs(repo, packets);
  } else if (wantsV2 && command === 'command=fetch') {
    out = handleFetchV2(repo, packets);
  } else if (!wantsV2) {
    out = handleFetchV0(repo, packets);
  } else {
    throw new Error(`unsupported upload-pack command ${JSON.stringify(command)}`);
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: out };
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePackBody(
  store: ForgeStore,
  repo: Repo,
  body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  const { packets, streamEnd } = parseLeadingPackets(body);
  const commands: PushCommand[] = [];
  let sideband = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packetText(packet).replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const head = nul < 0 ? text : text.slice(0, nul);
    const caps = nul < 0 ? '' : text.slice(nul + 1);
    if (caps.includes('side-band-64k')) sideband = true;
    const parts = head.split(' ');
    if (parts.length < 3) throw new Error(`bad push command ${JSON.stringify(head.slice(0, 60))}`);
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (commands.length === 0) throw new Error('push with no commands');

  const reportLines: string[] = [];
  const packBytes = body.subarray(streamEnd);
  const needsPack = commands.some((command) => command.newOid !== ZERO_ID);
  if (needsPack) {
    try {
      const unpacked = readPackFile(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of unpacked) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
      reportLines.push('unpack ok\n');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      reportLines.push(`unpack ${detail}\n`);
      for (const command of commands) {
        reportLines.push(`ng ${command.ref} unpacker error\n`);
      }
      return finishPushReport(reportLines, sideband);
    }
  } else {
    reportLines.push('unpack ok\n');
  }

  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_ID) {
      // Delete.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
      } else if (command.oldOid !== ZERO_ID && command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      } else {
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      reportLines.push(`ng ${command.ref} object not found\n`);
      continue;
    }
    if (command.oldOid === ZERO_ID) {
      // Create.
      if (current !== undefined) {
        reportLines.push(`ng ${command.ref} already exists\n`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (current === undefined) {
      reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
      continue;
    }
    if (current !== command.oldOid) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    if (!store.fastForward(repo, command.oldOid, command.newOid)) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }
  return finishPushReport(reportLines, sideband);
}

function finishPushReport(
  lines: string[],
  sideband: boolean,
): { status: number; contentType: string; body: Buffer } {
  const stream = encodePktList([...lines, 'flush']);
  const body = sideband ? Buffer.concat([sidebandPack(stream), pktFlush()]) : stream;
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body };
}

export { splitPktLines };

// ---------------------------------------------------------------------------
// HTTP routing for git smart HTTP
// ---------------------------------------------------------------------------

export interface GitHttpReply {
  status: number;
  headers?: Record<string, string>;
  body: Buffer | string;
}

/**
 * Answer one git smart-HTTP request, or null when the path is not a git
 * route. The caller owns auth; a missing repository is a 404.
 */
export function handleGitRoute(
  store: ForgeStore,
  method: string,
  path: string,
  query: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
): GitHttpReply | null {
  const segments = path.split('/').filter((part) => part !== '');
  if (segments.length < 3) return null;
  const owner = decodeURIComponent(segments[0]!);
  const repoPart = decodeURIComponent(segments[1]!);
  if (!repoPart.endsWith('.git')) return null;
  const repoName = repoPart.slice(0, -'.git'.length);
  const tail = segments.slice(2).join('/');
  const repo = store.getRepo(owner, repoName);
  if (!repo) return { status: 404, body: 'Not Found' };

  if (method === 'GET' && tail === 'info/refs') {
    const service = query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return { status: 400, body: 'Invalid service' };
    }
    const wantsV2 = (headers['git-protocol'] ?? headers['Git-Protocol'] ?? '') === 'version=2';
    const response = infoRefsBody(repo, service, wantsV2);
    return { status: response.status, headers: { 'content-type': response.contentType }, body: response.body };
  }

  if (method === 'POST' && tail === 'git-upload-pack') {
    const wantsV2 = (headers['git-protocol'] ?? headers['Git-Protocol'] ?? '') === 'version=2';
    const response = uploadPackBody(repo, body, wantsV2);
    return {
      status: response.status,
      headers: { 'content-type': response.contentType },
      body: response.body,
    };
  }

  if (method === 'POST' && tail === 'git-receive-pack') {
    const response = receivePackBody(store, repo, body);
    return {
      status: response.status,
      headers: { 'content-type': response.contentType },
      body: response.body,
    };
  }

  return null;
}
