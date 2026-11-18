// 测试用 Cap'n Proto 消息构造器：只生成 docs/upstream.md 约定子集内的编码。
// far 指针约定：bit2-31 = landing word，bit32-62 = segment，bit63 = double-far。
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

function offsetField(offset) {
  // Cap'n Proto 偏移是 30 位有符号整数，构造时按补码写入无符号低 30 位。
  return BigInt(offset & 0x3fffffff);
}

export function structPointer({ offset, dataWords, pointerWords }) {
  const raw = offsetField(offset) << 2n;
  return raw | (BigInt(dataWords) << 32n) | (BigInt(pointerWords) << 48n);
}

export function listPointer({ offset, elementSize, count }) {
  const sizes = { empty: 0, bit: 1, byte: 2, twoBytes: 3, fourBytes: 4, eightBytes: 5, pointer: 6, composite: 7 };
  const raw = offsetField(offset) << 2n;
  return raw | 1n | (BigInt(sizes[elementSize]) << 32n) | (BigInt(count) << 35n);
}

export function farPointer({ landingWord, segment, doubleFar = false }) {
  const raw = BigInt(landingWord & 0x3fffffff) << 2n;
  return raw | 2n | (BigInt(segment & 0x7fffffff) << 32n)
    | (doubleFar ? (1n << 63n) : 0n);
}

export function compositeTag({ dataWords, pointerWords, count }) {
  // tag 本身是 struct 指针样式（offset=-1 指向 list 指针自身），元素数由 list 指针携带。
  const raw = offsetField(-1) << 2n;
  return raw | (BigInt(dataWords) << 32n) | (BigInt(pointerWords) << 48n);
}

// segments: Buffer[]，每个是一段（长度须为 8 的倍数）。输出未打包 framing。
export function frame(segments) {
  const headerWords = Math.ceil((segments.length + 1) / 2);
  const header = Buffer.alloc(headerWords * 8);
  header.writeUInt32LE(segments.length - 1, 0);
  segments.forEach((segment, index) => {
    if (segment.length % 8 !== 0) throw new Error('segment_not_words');
    header.writeUInt32LE(segment.length / 8, 4 + index * 4);
  });
  return Buffer.concat([header, ...segments]);
}

export function words(...bigValues) {
  const buffer = Buffer.alloc(bigValues.length * 8);
  bigValues.forEach((value, index) => buffer.writeBigUInt64LE(BigInt(value), index * 8));
  return buffer;
}

// 起一个只服务给定字节的可统计区间来源，记录每次 Range。
export function startRangeSource(resources) {
  const requests = [];
  const etags = Object.fromEntries(Object.entries(resources)
    .map(([path, bytes]) => [path, `"${createHash('sha256').update(bytes).digest('hex')}"`]));
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const bytes = resources[url.pathname];
    if (!bytes) { response.writeHead(404); return response.end('not_found'); }
    requests.push({ path: url.pathname, range: request.headers.range ?? null,
      ifMatch: request.headers['if-match'] ?? null });
    const etag = etags[url.pathname];
    response.setHeader('ETag', etag);
    response.setHeader('Accept-Ranges', 'bytes');
    if (request.headers['if-match'] && request.headers['if-match'] !== etag) {
      response.writeHead(412); return response.end('version_changed');
    }
    if (request.headers.range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
      if (!match) { response.writeHead(416); return response.end('invalid_range'); }
      const begin = Number(match[1]);
      const end = match[2] ? Number(match[2]) : bytes.length - 1;
      if (begin > end || end >= bytes.length || begin < 0) {
        response.writeHead(416); return response.end('invalid_range');
      }
      response.setHeader('Content-Range', `bytes ${begin}-${end}/${bytes.length}`);
      response.writeHead(206);
      return response.end(bytes.subarray(begin, end + 1));
    }
    response.writeHead(200); response.end(bytes);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      requests,
      etags,
      close: () => new Promise(done => server.close(done)),
    }));
  });
}
