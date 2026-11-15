// Forge's git core: object ids, loose-object encoding, trees/commits/tags,
// packfiles (read + write, with delta resolution) and pkt-line framing.
//
// Written from the git protocol spec for this forge. No git binary is used
// anywhere: every object id is a SHA-1 over "<type> <size>\0<bytes>", every pack
// is built and parsed by hand, and every delta is applied by hand.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync as inflate } from 'node:zlib';

// ---------------------------------------------------------------------------
// object ids and loose encoding
// ---------------------------------------------------------------------------

export const ZERO_ID = '0'.repeat(40);

export type GitKind = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitKind;
  data: Buffer;
}

const KIND_CODE: Record<GitKind, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_KIND: Record<number, GitKind> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** SHA-1 of "<type> <size>\0<data>", the git object id. */
export function hashGitObject(type: GitKind, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** The stored (loose) bytes of an object: header + raw content. */
export function looseBytes(type: GitKind, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'ascii'), data]);
}

// ---------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------

export interface TreeItem {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's raw bytes into its entries, in stored order. */
export function parseTreeBytes(data: Buffer): TreeItem[] {
  const items: TreeItem[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(at, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    items.push({ mode, name, oid });
    at = nul + 21;
  }
  return items;
}

/** Build a tree object's raw bytes. Entries must already be in git order. */
export function buildTreeBytes(entries: readonly TreeItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Git's tree sort: directory names sort as if they ended with "/". */
export function treeSortKey(mode: string, name: string): string {
  return mode === '40000' ? `${name}/` : name;
}

// ---------------------------------------------------------------------------
// commits and tags
// ---------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's raw bytes. */
export function parseCommitBytes(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

/** Build a commit object's raw bytes from its fields. */
export function buildCommitBytes(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  lines.push('');
  lines.push(info.message.endsWith('\n') ? info.message : `${info.message}\n`);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TagInfo {
  object: string;
  type: GitKind;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object's raw bytes. */
export function parseTagBytes(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const info: TagInfo = { object: '', type: 'commit', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim() as GitKind;
    else if (line.startsWith('tag ')) info.tag = line.slice(4);
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

/** Build an annotated tag object's raw bytes. */
export function buildTagBytes(info: TagInfo): Buffer {
  const lines = [
    `object ${info.object}`,
    `type ${info.type}`,
    `tag ${info.tag}`,
    `tagger ${info.tagger}`,
    '',
    info.message.endsWith('\n') ? info.message : `${info.message}\n`,
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * Every object reachable from `tips`: commits (and their trees, blobs and
 * tags) walked iteratively, so a deep history never overflows the stack.
 */
export function reachableObjects(tips: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const tip of tips) {
    if (tip !== ZERO_ID && !seen.has(tip)) {
      seen.add(tip);
      stack.push(tip);
    }
  }
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    const object = lookup(oid);
    if (!object) continue;
    const push = (next: string): void => {
      if (next !== ZERO_ID && !seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    };
    if (object.type === 'commit') {
      const commit = parseCommitBytes(object.data);
      push(commit.tree);
      for (const parent of commit.parents) push(parent);
    } else if (object.type === 'tree') {
      for (const item of parseTreeBytes(object.data)) push(item.oid);
    } else if (object.type === 'tag') {
      push(parseTagBytes(object.data).object);
    }
  }
  return seen;
}

/**
 * True when `ancestor` is reachable from `tip` (or they are the same). A
 * targeted walk that stops the moment it finds the ancestor: a full
 * reachability set would make every push on a long linear history walk the
 * whole history, which is quadratic over a push chain.
 */
export function isAncestor(ancestor: string, tip: string, lookup: ObjectLookup): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      for (const parent of parseCommitBytes(object.data).parents) {
        if (parent === ancestor) return true;
        stack.push(parent);
      }
    } else if (object.type === 'tag') {
      const target = parseTagBytes(object.data).object;
      if (target === ancestor) return true;
      stack.push(target);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// deltas
// ---------------------------------------------------------------------------

/** Read a delta's variable-length size prefix. */
function readDeltaSize(data: Buffer, at: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = at;
  for (;;) {
    const byte = data[pos];
    pos += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: pos };
}

/**
 * Apply a git delta to its base, producing the target bytes. The delta format:
 * source size, target size, then copy/insert operations.
 */
export function applyDeltaBytes(base: Buffer, delta: Buffer): Buffer {
  const source = readDeltaSize(delta, 0);
  if (source.value !== base.length) throw new Error('delta base size mismatch');
  const target = readDeltaSize(delta, source.next);
  const out: Buffer[] = [];
  let made = 0;
  let pos = target.next;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          offset |= delta[pos] << (bit * 8);
          pos += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) {
          size |= delta[pos] << (bit * 8);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      made += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      made += op;
    } else {
      throw new Error('delta has a zero opcode');
    }
  }
  if (made !== target.value) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

/** Build a delta that inserts the whole target (no copy ops): always valid. */
export function plainDelta(target: Buffer): Buffer {
  const encode = (value: number): Buffer => {
    const bytes: number[] = [];
    let rest = value;
    do {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest !== 0) byte |= 0x80;
      bytes.push(byte);
    } while (rest !== 0);
    return Buffer.from(bytes);
  };
  const head = Buffer.concat([encode(0), encode(target.length)]);
  // Insert ops take at most 127 bytes each; split the target into chunks.
  const chunks: Buffer[] = [head];
  for (let at = 0; at < target.length; at += 127) {
    const piece = target.subarray(at, Math.min(target.length, at + 127));
    chunks.push(Buffer.from([piece.length]), piece);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

/** Encode one pack entry's type+size header (the git varint form). */
function packEntryHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  if (size !== 0) first |= 0x80;
  bytes.push(first);
  while (size !== 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size !== 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/**
 * Write a packfile (version 2) holding `objects` as full entries, never
 * deltas. A client that reads packs resolves every entry by its recomputed id.
 */
export function writePackFile(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [Buffer.from('PACK'), Buffer.alloc(4), Buffer.alloc(4)];
  parts[1].writeUInt32BE(2, 0);
  parts[2].writeUInt32BE(list.length, 0);
  for (const object of list) {
    const header = packEntryHeader(KIND_CODE[object.type], object.data.length);
    parts.push(header, deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

export interface PackEntry {
  type: GitKind;
  data: Buffer;
  oid: string;
}

/**
 * Read a packfile, resolving OFS_DELTA and REF_DELTA entries. `external`
 * supplies base objects a thin pack leaves out (objects the peer already has).
 */
export function readPackFile(
  pack: Buffer,
  external?: ObjectLookup,
): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerAt = pack.length - 20;
  const trailer = pack.subarray(trailerAt).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerAt)).digest('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');

  interface Raw {
    offset: number;
    code: number;
    size: number;
    payload: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raws: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let at = 12;
  for (let index = 0; index < count; index += 1) {
    const start = at;
    // Varint type+size header.
    let byte = pack[at];
    at += 1;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[at];
      at += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const raw: Raw = { offset: start, code, size, payload: Buffer.alloc(0) };
    if (code === 6) {
      // OFS_DELTA: negative offset to the base entry.
      let b = pack[at];
      at += 1;
      let baseOff = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = pack[at];
        at += 1;
        baseOff = ((baseOff + 1) << 7) | (b & 0x7f);
      }
      raw.baseOffset = start - baseOff;
    } else if (code === 7) {
      raw.baseOid = pack.subarray(at, at + 20).toString('hex');
      at += 20;
    } else if (!CODE_KIND[code]) {
      throw new Error(`unknown pack entry type ${code}`);
    }
    // Inflate exactly one stream and learn how many bytes it consumed.
    const { data, next } = inflateWithLength(pack, at, trailerAt);
    if (data.length !== size) throw new Error('pack entry size mismatch');
    raw.payload = data;
    at = next;
    raws.push(raw);
    byOffset.set(start, raw);
  }
  if (at !== trailerAt) throw new Error('pack has trailing bytes before its trailer');

  const resolved = new Map<string, GitObject>();
  const byOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (raw: Raw): GitObject => {
    if (raw.code === 6) {
      const baseRaw = byOffset.get(raw.baseOffset as number);
      if (!baseRaw) throw new Error('ofs-delta base missing from pack');
      const base = resolveRaw(baseRaw);
      const data = applyDeltaBytes(base.data, raw.payload);
      return { type: base.type, data };
    }
    if (raw.code === 7) {
      const wanted = raw.baseOid as string;
      const inPack = byOid.get(wanted);
      let base: GitObject;
      if (inPack) base = resolveRaw(inPack);
      else {
        const found = external?.(wanted);
        if (!found) throw new Error(`ref-delta base ${wanted} is not available`);
        base = found;
      }
      const data = applyDeltaBytes(base.data, raw.payload);
      return { type: base.type, data };
    }
    return { type: CODE_KIND[raw.code], data: raw.payload };
  };
  const resolveRaw = (raw: Raw): GitObject => {
    if (resolving.has(raw.offset)) throw new Error('delta cycle in pack');
    resolving.add(raw.offset);
    const object = resolve(raw);
    const realOid = hashGitObject(object.type, object.data);
    resolved.set(realOid, object);
    byOid.set(realOid, raw);
    resolving.delete(raw.offset);
    return object;
  };
  for (const raw of raws) resolveRaw(raw);
  return resolved;
}

/**
 * Inflate one zlib stream inside `pack` starting at `at` and report exactly
 * how many input bytes the stream consumed, using the streaming API.
 */
function inflateWithLength(
  pack: Buffer,
  at: number,
  limit: number,
): { data: Buffer; next: number } {
  // Feed the stream in slices and stop as soon as inflateSync on a slice
  // succeeds without an "unexpected end" error; the smallest working slice
  // end is the stream's end. Deflate streams are self-terminating, so a
  // binary search over the end position finds the exact boundary.
  let low = at + 1;
  let high = limit;
  let found = -1;
  const probe = (end: number): boolean => {
    try {
      inflate(pack.subarray(at, end));
      return true;
    } catch {
      return false;
    }
  };
  // A stream that ends exactly at `limit` is common; check the edges first.
  if (probe(limit)) {
    // Binary-search the smallest end that inflates cleanly.
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (probe(mid)) {
        found = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
  }
  if (found < 0) throw new Error('cannot inflate pack entry');
  return { data: inflate(pack.subarray(at, found)), next: found };
}

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

/** Encode one pkt-line: 4 hex digits of length (payload + 4) + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 65520) throw new Error('pkt-line too long');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), body]);
}

/** The flush packet: "0000". */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delim packet: "0001". */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/**
 * Split a whole buffer into pkt-line packets. Throws on a malformed frame.
 * Sideband data (band byte + bytes) arrives as one `data` packet per frame.
 */
export function splitPktLines(buffer: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let at = 0;
  while (at < buffer.length) {
    if (at + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const head = buffer.subarray(at, at + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      at += 4;
      continue;
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
    if (!Number.isFinite(length) || length < 4 || at + length > buffer.length) {
      throw new Error(`bad pkt-line length ${head}`);
    }
    packets.push({ kind: 'data', payload: buffer.subarray(at + 4, at + length) });
    at += length;
  }
  return packets;
}

/** Encode a list of lines (strings, 'flush' or 'delim') as pkt-lines. */
export function encodePktList(lines: readonly (string | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}
