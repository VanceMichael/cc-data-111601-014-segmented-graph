import { acquireRange } from './transport.mjs';

// 定向领取会话：统计遍历消耗的词数与对来源的真实请求数。
// counters 可跨多次尝试共享，使 maxWords/maxRequests 成为可观察的资源边界。
export class Session {
  constructor({ fetchRange, limits, counters }) {
    this.fetchRange = fetchRange;
    this.limits = limits;
    this.counters = counters ?? { words: 0, requests: 0 };
  }
  async readBytes(start, end) {
    this.counters.words += (end - start) / 8;
    if (this.counters.words > this.limits.maxWords) throw new Error('word_budget_exceeded');
    return this.fetchRange(start, end);
  }
}

// 按 (来源地址, 文件版本) 缓存已核实的字节区间；同一来源的多次投影复用这些区间。
// 未命中时携带 If-Match 钉住版本；每次会话的首次读取用 If-None-Match 复核版本，
// 源文件更换后作废旧区间并整轮重取，不沿用旧的指针解释。
export class RangeSource {
  constructor(base) {
    this.base = base;
    this.entries = new Map(); // href → { version, ranges: [{start, end, bytes}] }
  }

  invalidate(path) {
    this.entries.delete(new URL(path, this.base).href);
  }

  versionOf(path) {
    return this.entries.get(new URL(path, this.base).href)?.version;
  }

  session(path, limits, counters) {
    const href = new URL(path, this.base).href;
    const source = this;
    const spend = () => {
      counters.requests += 1;
      if (counters.requests > limits.maxRequests) throw new Error('request_budget_exceeded');
    };
    const check = (response, start, end) => {
      if (response.status === 412) throw new Error('source_version_changed');
      if (response.status !== 206) throw new Error('source_range_rejected');
      const etag = response.headers.etag;
      if (!etag) throw new Error('source_version_missing');
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] ?? '');
      if (!match || Number(match[1]) !== start || Number(match[2]) !== end - 1) {
        throw new Error('source_range_mismatch');
      }
      if (response.bytes.length !== end - start) throw new Error('source_range_mismatch');
      return etag;
    };
    const store = (etag, start, end, bytes) => {
      let entry = source.entries.get(href);
      if (entry && entry.version !== etag) {
        source.entries.delete(href);
        entry = undefined;
      }
      if (!entry) {
        entry = { version: etag, ranges: [] };
        source.entries.set(href, entry);
      }
      insert(entry.ranges, start, end, bytes);
      return bytes;
    };
    const miss = async (start, end) => {
      spend();
      const entry = source.entries.get(href);
      const response = await acquireRange(source.base, href, start, end,
        entry ? { 'if-match': entry.version } : {});
      const etag = check(response, start, end);
      if (entry && etag !== entry.version) throw new Error('source_version_changed');
      return store(etag, start, end, response.bytes);
    };
    // 会话首次读取：若命中缓存，先发条件请求复核版本；304 复用已核实字节，
    // 206 且 ETag 不同说明源文件已更换，作废旧区间后以新版本重新领取。
    const revalidate = async (start, end) => {
      const entry = source.entries.get(href);
      spend();
      const response = await acquireRange(source.base, href, start, end,
        { 'if-none-match': entry.version });
      if (response.status === 304) return assemble(entry.ranges, start, end);
      const etag = check(response, start, end);
      return store(etag, start, end, response.bytes);
    };
    let first = true;
    const fetchRange = async (start, end) => {
      const entry = source.entries.get(href);
      const covered = entry && covers(entry.ranges, start, end);
      if (first && covered) {
        first = false;
        return revalidate(start, end);
      }
      first = false;
      if (covered) return assemble(entry.ranges, start, end);
      return miss(start, end);
    };
    return new Session({ fetchRange, limits, counters });
  }
}

function covers(ranges, start, end) {
  return ranges.some(range => range.start <= start && range.end >= end);
}

function assemble(ranges, start, end) {
  const range = ranges.find(item => item.start <= start && item.end >= end);
  return range.bytes.subarray(start - range.start, end - range.start);
}

function insert(ranges, start, end, bytes) {
  ranges.push({ start, end, bytes });
  ranges.sort((a, b) => a.start - b.start);
  for (let index = 0; index + 1 < ranges.length; index += 1) {
    const current = ranges[index];
    const next = ranges[index + 1];
    if (current.end >= next.start) {
      const merged = { start: current.start, end: Math.max(current.end, next.end) };
      merged.bytes = Buffer.concat([current.bytes,
        next.bytes.subarray(Math.max(0, current.end - next.start))]);
      ranges.splice(index, 2, merged);
      index -= 1;
    }
  }
}

// 本地字节会话：用于无 HTTP 的遍历与预算测试；每次读取都计为一次请求。
export function bufferSession(bytes, limits = { maxWords: 1024, maxRequests: 64 }) {
  const counters = { words: 0, requests: 0 };
  const fetchRange = async (start, end) => {
    counters.requests += 1;
    if (counters.requests > limits.maxRequests) throw new Error('request_budget_exceeded');
    if (end > bytes.length) throw new Error('capnp_bounds');
    return bytes.subarray(start, end);
  };
  return new Session({ fetchRange, limits, counters });
}
