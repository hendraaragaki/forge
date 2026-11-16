// Git smart-HTTP surface: upload-pack v2 (+ v0 fallback) and receive-pack v0.
//
// Node 22 stdlib only (node:http, node:zlib, node:crypto). No git binary, no
// network. Packfiles are written delta-free (full objects only, zlib-deflated);
// packfiles are read with full delta resolution (OFS_DELTA and REF_DELTA,
// including thin packs whose REF_DELTA bases live in the repo store).
//
// Protocol notes (the suite's git-client.ts is the reference for what the
// client sends and expects):
//   - GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack
//        Git-Protocol: version=2  -> "version 2" + capability lines.
//        otherwise                -> "# service=git-upload-pack" preamble +
//                                    v0 ref advertisement (side-band-64k,
//                                    thin-pack, ofs-delta, shallow, symref).
//   - GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack
//        always v0: "# service=git-receive-pack" preamble, advertising
//        report-status, side-band-64k, delete-refs.
//   - POST /{owner}/{repo}.git/git-upload-pack
//        v2 "command=ls-refs" / "command=fetch" (dispatched on the first
//        pkt-line), or a v0 want/have/done exchange. Fetch answers with
//        acknowledgments / shallow-info / packfile sections, the packfile
//        carried in sideband band 1.
//   - POST /{owner}/{repo}.git/git-receive-pack
//        v0 command list + pack; per-ref report-status inside sideband
//        band 1. Fast-forward only: a non-fast-forward update is refused
//        per ref with "ng <ref> non-fast-forward" and the ref does not move.
//   - Auth: Bearer <token> on every git route; missing/wrong -> 401.
//     A repository is created through REST; a push cannot invent one, so a
//     missing repo is a plain 404 on every git route.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, parseCommit, parseTree } from './store.ts';
import type { GitObject, ObjectType, Repo, Store } from './store.ts';
import { isAuthorized, pathOf, queryOf, readBody, sendRaw } from './util.ts';

const ZERO_OID = '0'.repeat(40);
const AGENT = 'makefun-forge/1.0';
/** git's LARGE_PACKET_MAX: largest pkt-line including its 4-byte length. */
const PKT_LINE_MAX = 65520;
/** Sideband data chunk: comfortably under the pkt-line limit. */
const SIDEBAND_CHUNK = 32768;

const TYPE_CODE: Readonly<Record<ObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, ObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const HEX40 = /^[0-9a-f]{40}$/;
const HEX4 = /^[0-9a-fA-F]{4}$/;

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new Error('pkt-line payload too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

function pktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

type DecodedPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Decode pkt-lines from `buf` starting at `start`. Stops at the first flush
 * and returns the offset just past it, so a caller can treat the rest of the
 * buffer as raw bytes (the receive-pack packfile). Throws on a malformed
 * header, an over-long packet or a truncation.
 */
function decodeUntilFlush(buf: Buffer, start = 0): { packets: DecodedPacket[]; rest: number } {
  const packets: DecodedPacket[] = [];
  let offset = start;
  for (;;) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) return { packets, rest: offset + 4 };
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
}

/** Decode a whole buffer of pkt-lines (upload-pack requests); trailing bytes are an error. */
function decodeAll(buf: Buffer): DecodedPacket[] {
  const packets: DecodedPacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

function dataLines(packets: readonly DecodedPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// packfile write (delta-free) and read (with delta resolution)
// ---------------------------------------------------------------------------------------------

function writePackObjectHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). Trailer is SHA-1 over the rest. */
function writePack(objects: ReadonlyArray<{ type: ObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Read a packfile (version 2/3) and resolve every object, including OFS_DELTA
 * and REF_DELTA. A REF_DELTA base may live in the pack or be supplied by
 * `resolveBase` (a thin pack against the repo store). Returns oid -> object.
 * Throws on any structural problem (bad header, bad trailer, bad zlib,
 * unresolvable delta base, size mismatch).
 */
function readPack(pack: Buffer, resolveBase: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, { type: ObjectType; data: Buffer }>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: ObjectType; data: Buffer; oid: string } => {
    const cached = (entry as RawPackEntry & { resolved?: { type: ObjectType; data: Buffer; oid: string } }).resolved;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        data = applyDelta(baseEntry.data, entry.data);
        type = baseEntry.type;
      } else {
        const external = resolveBase(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the store`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    (entry as RawPackEntry & { resolved?: { type: ObjectType; data: Buffer; oid: string } }).resolved = out;
    resolvedByOid.set(oid, { type, data });
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------------------------
// repo object graph
// ---------------------------------------------------------------------------------------------

function parseTagTarget(data: Buffer): { object: string; type: string } | null {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  let object = '';
  let type = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
  }
  if (!HEX40.test(object)) return null;
  return { object, type };
}

/** Follow annotated tags until a non-tag object; undefined when unresolvable. */
function peelToNonTag(repo: Repo, oid: string): string | undefined {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (!obj) return undefined;
    if (obj.type !== 'tag') return current;
    const target = parseTagTarget(obj.data);
    if (!target) return undefined;
    current = target.object;
  }
}

interface WalkOptions {
  /** Max commit generations from a root (1 = roots only); undefined = unlimited. */
  maxCommitDepth?: number;
  /** Commits whose parents the walker must not follow (a shallow client's boundary). */
  stopParentsAt?: ReadonlySet<string>;
  /** Commits to leave out entirely (deepen-not). */
  excludeCommits?: ReadonlySet<string>;
  /** Commits older than this committer timestamp are cut (deepen-since). */
  sinceCutoff?: number;
}

/**
 * Objects reachable from `roots` (commits -> tree + parents, tags -> target,
 * trees -> entries, gitlinks skipped). Commits deeper than maxCommitDepth are
 * still included, but their parents are not followed. Returns the set plus,
 * post-hoc, the boundary commits: included commits with at least one parent
 * present in the store that was not included.
 */
function walkObjects(repo: Repo, roots: Iterable<string>, options: WalkOptions = {}): { objects: Set<string>; boundary: Set<string> } {
  const objects = new Set<string>();
  const commitDepth = new Map<string, number>();
  interface Task {
    oid: string;
    depth: number;
  }
  const stack: Task[] = [];
  for (const root of roots) {
    if (HEX40.test(root)) stack.push({ oid: root, depth: 1 });
  }
  while (stack.length > 0) {
    const task = stack.pop() as Task;
    const obj = repo.objects.get(task.oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      const seenDepth = commitDepth.get(task.oid);
      if (seenDepth !== undefined && seenDepth <= task.depth) continue;
      if (options.excludeCommits?.has(task.oid)) continue;
      commitDepth.set(task.oid, task.depth);
      objects.add(task.oid);
      const commit = parseCommit(obj.data);
      stack.push({ oid: commit.tree, depth: task.depth });
      const cut =
        (options.maxCommitDepth !== undefined && task.depth >= options.maxCommitDepth) ||
        options.stopParentsAt?.has(task.oid) ||
        (options.sinceCutoff !== undefined && commit.committerTime < options.sinceCutoff);
      if (!cut) {
        for (const parent of commit.parents) stack.push({ oid: parent, depth: task.depth + 1 });
      }
      continue;
    }
    if (objects.has(task.oid)) continue;
    objects.add(task.oid);
    if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target) stack.push({ oid: target.object, depth: task.depth });
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '160000') continue;
        stack.push({ oid: entry.sha, depth: task.depth });
      }
    }
  }
  const boundary = new Set<string>();
  for (const oid of objects) {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (repo.objects.has(parent) && !objects.has(parent)) {
        boundary.add(oid);
        break;
      }
    }
  }
  return { objects, boundary };
}

/** All commits reachable from `roots` (parents + tag targets), for deepen-not. */
function reachableCommits(repo: Repo, roots: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [];
  for (const root of roots) if (HEX40.test(root)) stack.push(root);
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      out.add(oid);
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    } else if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target) stack.push(target.object);
    }
  }
  return out;
}

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

function headOid(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

// ---------------------------------------------------------------------------------------------
// sideband
// ---------------------------------------------------------------------------------------------

/** Wrap raw bytes in sideband band-1 pkt-lines, chunked under the pkt-line limit. */
function sidebandData(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_CHUNK) {
    const chunk = data.subarray(offset, offset + SIDEBAND_CHUNK);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

function sidebandError(message: string): Buffer {
  return pktLine(Buffer.concat([Buffer.from([3]), Buffer.from(`${message}\n`, 'utf8')]));
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function v2Capabilities(): Buffer {
  return pktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

function v0UploadCapabilities(repo: Repo): string {
  return [
    'side-band-64k',
    'thin-pack',
    'ofs-delta',
    'shallow',
    'multi_ack_detailed',
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
    `agent=${AGENT}`,
  ].join(' ');
}

function v0ReceiveCapabilities(repo: Repo): string {
  return [
    'report-status',
    'side-band-64k',
    'delete-refs',
    'ofs-delta',
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
    `agent=${AGENT}`,
  ].join(' ');
}

/** A v0 ref advertisement (upload-pack or receive-pack) with its service preamble. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? v0UploadCapabilities(repo) : v0ReceiveCapabilities(repo);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const names = sortedRefNames(repo);
  if (names.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = headOid(repo) ?? ZERO_OID;
    parts.push(pktLine(`${head} HEAD\0${caps}\n`));
    for (const name of names) {
      const oid = repo.refs.get(name) as string;
      parts.push(pktLine(`${oid} ${name}\n`));
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelToNonTag(repo, oid);
        if (peeled !== undefined && peeled !== oid) parts.push(pktLine(`${peeled} ${name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const head = headOid(repo);
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  // HEAD is a ref like any other for prefix filtering: it is listed when it
  // matches a ref-prefix (real git clones ask for "ref-prefix HEAD"), and
  // when no prefix was given at all. The old code only listed HEAD when no
  // prefix was given, so a real clone saw no HEAD symref and failed with
  // "remote HEAD refers to nonexistent ref, unable to checkout".
  if (matches('HEAD')) {
    if (head !== undefined) {
      lines.push(`${head} HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
  }
  for (const name of sortedRefNames(repo)) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelToNonTag(repo, oid);
        if (peeled !== undefined && peeled !== oid) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  return pktLines([...lines, 'flush']);
}

// ---------------------------------------------------------------------------------------------
// fetch (v2 and v0)
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot: string[];
}

function computeFetchPack(repo: Repo, args: FetchArgs): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const clientShallow = new Set(args.shallow);
  const excluded = args.deepenNot.length > 0 ? reachableCommits(repo, args.deepenNot) : undefined;
  const want = walkObjects(repo, args.wants, {
    maxCommitDepth: args.depth,
    excludeCommits: excluded,
    sinceCutoff: args.deepenSince,
  });
  const have = walkObjects(repo, args.haves, { stopParentsAt: clientShallow });
  const send = new Set<string>();
  for (const oid of want.objects) if (!have.objects.has(oid)) send.add(oid);
  const objects = [...send].sort().map((oid) => {
    const obj = repo.objects.get(oid) as GitObject;
    return { type: obj.type, data: obj.data };
  });
  const shallow: string[] = [];
  for (const oid of want.boundary) shallow.push(oid);
  shallow.sort();
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    if (want.objects.has(oid) && !want.boundary.has(oid)) unshallow.push(oid);
  }
  unshallow.sort();
  return { pack: writePack(objects), shallow, unshallow };
}

function fetchV2Response(repo: Repo, args: FetchArgs): Buffer {
  const unknown = args.wants.filter((oid) => !repo.objects.has(oid));
  const parts: Buffer[] = [];
  // The acknowledgments section exists ONLY when the client sent have lines.
  // A fresh clone sends none, and real git then expects the response to open
  // with the packfile section: sending acknowledgments there dies with
  // "expected 'packfile', received 'acknowledgments'". (Verified against a
  // real git daemon: no-haves fetch -> "packfile" first; with haves ->
  // "acknowledgments" + ACK + ready + delim, then "packfile".)
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    const held = args.haves.filter((oid) => repo.objects.has(oid));
    if (held.length === 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      for (const oid of held) parts.push(pktLine(`ACK ${oid}\n`));
      parts.push(pktLine('ready\n'));
    }
    parts.push(PKT_DELIM);
  }
  if (unknown.length > 0) {
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandError(`object not found ${unknown[0]}`));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  const { pack, shallow, unshallow } = computeFetchPack(repo, args);
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandData(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0Response(repo: Repo, args: FetchArgs): Buffer {
  const unknown = args.wants.filter((oid) => !repo.objects.has(oid));
  // v0 has no section names: ACK/NAK lines lead, then the sideband pack.
  // ACK the haves we hold (a bare NAK when we hold none of them).
  const held = args.haves.filter((oid) => repo.objects.has(oid));
  const parts: Buffer[] = held.length === 0
    ? [pktLine('NAK\n')]
    : held.map((oid) => pktLine(`ACK ${oid}\n`));
  if (unknown.length > 0) {
    parts.push(sidebandError(`object not found ${unknown[0]}`));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  const { pack, shallow, unshallow } = computeFetchPack(repo, args);
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandData(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function parseFetchLines(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepenNot: [] };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0];
      if (HEX40.test(oid)) args.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (HEX40.test(oid)) args.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (HEX40.test(oid)) args.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    } else if (line.startsWith('deepen-since ')) {
      const n = Number.parseInt(line.slice(13).trim(), 10);
      if (Number.isFinite(n)) args.deepenSince = n;
    } else if (line.startsWith('deepen-not ')) {
      const oid = line.slice(11).trim();
      if (HEX40.test(oid)) args.deepenNot.push(oid);
    }
    // thin-pack, no-progress, ofs-delta, filter, done, agent, object-format: no action.
  }
  return args;
}

// ---------------------------------------------------------------------------------------------
// receive-pack (v0)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushCommands(lines: readonly string[]): { commands: PushCommand[]; sideband: boolean } {
  const commands: PushCommand[] = [];
  let sideband = false;
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index].replace(/\n$/, '');
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        const caps = line.slice(nul + 1).split(' ');
        sideband = caps.includes('side-band-64k');
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length !== 3) throw new Error(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts;
    if (!HEX40.test(oldOid) || !HEX40.test(newOid)) throw new Error('push command has a bad object id');
    if (!ref.startsWith('refs/')) throw new Error(`push command has a bad ref ${JSON.stringify(ref)}`);
    commands.push({ oldOid, newOid, ref });
  }
  return { commands, sideband };
}

function handleReceivePack(repo: Repo, store: Store, body: Buffer): Buffer {
  const { packets, rest } = decodeUntilFlush(body);
  const lines = dataLines(packets);
  const { commands, sideband } = parsePushCommands(lines);
  if (commands.length === 0) throw new Error('push needs at least one command');

  const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (rest < body.length) {
    try {
      const pack = body.subarray(rest);
      const objects = readPack(pack, (oid) => store.getObject(repo, oid));
      for (const [oid, obj] of objects) {
        const stored = store.putObject(repo, obj.type, obj.data);
        if (stored !== oid) throw new Error(`pack object recomputes to ${stored}, not ${oid}`);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = String(err instanceof Error ? err.message : err).replace(/[\r\n]+/g, ' ').slice(0, 200);
    }
  } else if (updatesRef) {
    unpackOk = false;
    unpackDetail = 'missing packfile';
  }

  const report: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  for (const command of commands) {
    let outcome: { ok: boolean; reason: string } | null = null;
    if (unpackOk) outcome = applyPushCommand(repo, store, command);
    if (outcome === null) outcome = { ok: false, reason: 'unpack failed' };
    report.push(outcome.ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${outcome.reason}\n`);
  }
  const stream = pktLines([...report, 'flush']);
  if (!sideband) return stream;
  return Buffer.concat([sidebandData(stream), PKT_FLUSH]);
}

/**
 * Apply one receive-pack command. Fast-forward only; a refused command leaves
 * the ref exactly as it was. Returns {ok, reason}; reason is the exact token
 * the suite's report parser reads ("non-fast-forward" for a history rewrite).
 */
function applyPushCommand(repo: Repo, store: Store, command: PushCommand): { ok: boolean; reason: string } {
  const current = store.getRef(repo, command.ref);
  if (command.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) return { ok: false, reason: 'old value mismatch' };
    store.deleteRef(repo, command.ref);
    return { ok: true, reason: '' };
  }
  const obj = store.getObject(repo, command.newOid);
  if (!obj) return { ok: false, reason: 'object not found' };
  if (command.ref.startsWith('refs/heads/') && obj.type !== 'commit') {
    return { ok: false, reason: 'not a commit' };
  }
  if (command.oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return { ok: false, reason: 'already exists' };
    store.setRef(repo, command.ref, command.newOid);
    return { ok: true, reason: '' };
  }
  // Update.
  if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
  if (current !== command.oldOid) return { ok: false, reason: 'old value mismatch' };
  if (command.newOid === current) return { ok: true, reason: '' };
  if (!store.isAncestor(repo, command.oldOid, command.newOid)) {
    return { ok: false, reason: 'non-fast-forward' };
  }
  store.setRef(repo, command.ref, command.newOid);
  return { ok: true, reason: '' };
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

function sendText(res: ServerResponse, status: number, text: string): void {
  sendRaw(res, status, Buffer.from(text, 'utf8'), 'text/plain; charset=utf-8');
}

async function handleInfoRefs(store: Store, req: IncomingMessage, res: ServerResponse, owner: string, name: string): Promise<void> {
  const service = queryOf(req).get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendText(res, 400, 'unknown service');
    return;
  }
  const repo = store.getRepo(owner, name);
  if (!repo) {
    sendText(res, 404, 'Not Found');
    return;
  }
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2') {
    sendRaw(res, 200, v2Capabilities(), contentType);
    return;
  }
  sendRaw(res, 200, v0Advertisement(repo, service), contentType);
}

async function handleUploadPack(store: Store, req: IncomingMessage, res: ServerResponse, owner: string, name: string): Promise<void> {
  const repo = store.getRepo(owner, name);
  if (!repo) {
    sendText(res, 404, 'Not Found');
    return;
  }
  const body = await readBody(req);
  if (body === null) {
    sendText(res, 400, 'body too large');
    return;
  }
  const packets = decodeAll(body);
  const lines = dataLines(packets);
  const command = (lines[0] ?? '').replace(/\n$/, '');
  if (command.startsWith('command=ls-refs')) {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const raw of lines.slice(1)) {
      const line = raw.replace(/\n$/, '');
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    }
    sendRaw(res, 200, handleLsRefs(repo, args), 'application/x-git-upload-pack-result');
    return;
  }
  if (command.startsWith('command=fetch')) {
    const args = parseFetchLines(lines.slice(1));
    sendRaw(res, 200, fetchV2Response(repo, args), 'application/x-git-upload-pack-result');
    return;
  }
  // v0 fetch: want/have/done (+ shallow/deepen) pkt-lines.
  const args = parseFetchLines(lines);
  sendRaw(res, 200, fetchV0Response(repo, args), 'application/x-git-upload-pack-result');
}

async function handleReceivePackRoute(store: Store, req: IncomingMessage, res: ServerResponse, owner: string, name: string): Promise<void> {
  const repo = store.getRepo(owner, name);
  if (!repo) {
    sendText(res, 404, 'Not Found');
    return;
  }
  const body = await readBody(req);
  if (body === null) {
    sendText(res, 400, 'body too large');
    return;
  }
  sendRaw(res, 200, handleReceivePack(repo, store, body), 'application/x-git-receive-pack-result');
}

/**
 * Handle a git smart-HTTP request. Returns true when the path is a git route
 * (even when answered 404/401), false when it is not a git route.
 */
export async function handleGit(store: Store, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = pathOf(req);
  const match = GIT_ROUTE.exec(path);
  if (!match) return false;
  const [, owner, name, kind] = match;
  try {
    if (kind === 'info/refs' && req.method !== 'GET') return false;
    if (kind !== 'info/refs' && req.method !== 'POST') return false;
    if (!isAuthorized(store, req)) {
      sendText(res, 401, 'Unauthorized');
      return true;
    }
    if (kind === 'info/refs') await handleInfoRefs(store, req, res, owner, name);
    else if (kind === 'git-upload-pack') await handleUploadPack(store, req, res, owner, name);
    else await handleReceivePackRoute(store, req, res, owner, name);
  } catch (err) {
    if (!res.headersSent) sendText(res, 400, 'bad request');
  }
  return true;
}
