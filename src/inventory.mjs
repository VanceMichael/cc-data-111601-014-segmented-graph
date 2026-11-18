import { acquireRange } from './transport.mjs';

// 同一来源路径 + 同一版本（ETag）的已核实字节清单。
// 区间按字节登记，重复领取只取尚未覆盖的部分；版本变化后整份清单作废，
// 不得沿用旧版本的指针解释。预算（maxRequests/maxWords）在每个 selection 上独立计量。
export class RangeInventory {
  constructor({ base, path, maxWords = Infinity, maxRequests = Infinity, fetch = acquireRange,
    prefetchWords = 2 } = {}) {
    this.base = base;
    this.path = path;
    this.maxWords = maxWords;
    this.maxRequests = maxRequests;
    this.fetch = fetch;
    this.prefetchWords = prefetchWords;
    this.etag = null;
    this.ranges = [];
    this.blocks = new Map();
    this.inflight = new Map();
    this.resourceLength = null;
    this.requestsUsed = 0;
    this.wordsUsed = 0;
  }

  version() {
    return this.etag;
  }

  // 登记版本探测时已经核实过的字节（通常只是 bytes=0-0），避免重复领取同一区间。
  // 兼容 acquire() 的 {bytes, headers} 与区间领取的 {begin,end,bytes,etag} 两种形态。
  absorbProbe(block) {
    const begin = block.begin ?? 0;
    const end = block.end ?? block.bytes.length - 1;
    const etag = block.etag ?? block.headers?.etag;
    if (this.etag && etag && etag !== this.etag) throw new Error('source_version_changed');
    if (etag) this.etag = etag;
    if (block.resourceLength !== undefined && block.resourceLength !== null) {
      this.resourceLength = block.resourceLength;
    } else if (block.headers?.['content-range']) {
      const match = /\/(\d+)$/.exec(block.headers['content-range']);
      if (match) this.resourceLength = Number(match[1]);
    }
    for (let offset = begin; offset <= end; offset += 1) {
      this.blocks.set(offset, block.bytes[offset - begin]);
    }
    this.ranges = mergeRange(this.ranges, [begin, end]);
  }

  covered(begin, end) {
    return this.ranges.some(([a, b]) => a <= begin && end <= b);
  }

  // 返回需求 [begin,end] 内尚未覆盖的缺口。只合并彼此间隔很小的相邻缺口，
  // 不会因为后面是大片未覆盖区就把需求外的区间也并进本次领取。
  missing(begin, end, gapFill = 8) {
    const gaps = [];
    let cursor = begin;
    for (const [a, b] of this.ranges) {
      if (b < cursor) continue;
      if (a > end) break;
      if (a > cursor) gaps.push([cursor, Math.min(a - 1, end)]);
      cursor = Math.max(cursor, b + 1);
      if (cursor > end) break;
    }
    if (cursor <= end) gaps.push([cursor, end]);
    const merged = [];
    for (const [a, b] of gaps) {
      const last = merged[merged.length - 1];
      if (last && a - last[1] - 1 <= gapFill) last[1] = b;
      else merged.push([a, b]);
    }
    return merged;
  }

  async ensure(begin, end) {
    if (begin < 0 || end < begin) throw new Error('invalid_range_span');
    // 串行化：并发 read 复用同一份区间视图，不会对同一缺口重复发请求。
    const previous = this.gate ?? Promise.resolve();
    let release;
    this.gate = new Promise(resolve => { release = resolve; });
    try {
      await previous;
      if (this.covered(begin, end)) return;
      // 只领取尚未覆盖的缺口；预取仅附加在最右侧缺口之后，且整段对齐到 word。
      // 已覆盖区间内的新需求不会再产生请求，更不会重复下载。
      for (const [a, b] of this.missing(begin, end)) {
        if (this.requestsUsed >= this.maxRequests) throw new Error('selection_request_budget');
        // 只在最右侧缺口后附带一次预取；已知资源长度时夹紧，避免 416 浪费请求。
        let spanEnd = b;
        const touchesRightEdge = !this.ranges.some(([, rb]) => rb >= b);
        if (touchesRightEdge) spanEnd = b + this.prefetchWords * 8 - 1;
        if (this.resourceLength !== null) spanEnd = Math.min(spanEnd, this.resourceLength - 1);
        const words = Math.ceil((spanEnd - a + 1) / 8);
        if (this.wordsUsed + words > this.maxWords) throw new Error('selection_word_budget');
        await this.#fetchSpan(a, spanEnd, b);
      }
    } finally {
      release();
    }
  }

  async #fetchSpan(a, b, exactEnd) {
    const key = `${a}-${b}`;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const operation = this.#doFetch(a, b, exactEnd)
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, operation);
    return operation;
  }

  async #doFetch(a, b, exactEnd) {
    let block;
    try {
      block = await this.fetch(this.base, this.path, { begin: a, end: b, etag: this.etag });
    } catch (error) {
      // 预取越过资源末尾（416）时退回到恰好需要的区间，不扩大领取范围。
      if (error.message !== 'source_status_416' || b <= exactEnd) throw error;
      block = await this.fetch(this.base, this.path, { begin: a, end: exactEnd, etag: this.etag });
    }
    this.requestsUsed += 1;
    this.wordsUsed += Math.ceil(block.bytes.length / 8);
    if (block.resourceLength !== undefined && block.resourceLength !== null) {
      this.resourceLength = block.resourceLength;
    }
    if (this.etag === null) {
      if (!block.etag) throw new Error('source_version_missing');
      this.etag = block.etag;
    } else if (block.etag && block.etag !== this.etag) {
      throw new Error('source_version_changed');
    }
    for (let offset = block.begin; offset <= block.end; offset += 1) {
      this.blocks.set(offset, block.bytes[offset - block.begin]);
    }
    this.ranges = mergeRange(this.ranges, [block.begin, block.end]);
  }

  async read(begin, end) {
    await this.ensure(begin, end);
    const out = Buffer.allocUnsafe(end - begin + 1);
    for (let offset = begin; offset <= end; offset += 1) out[offset - begin] = this.blocks.get(offset);
    return out;
  }

  async u8(offset) {
    return (await this.read(offset, offset))[0];
  }

  async u32(offset) {
    return (await this.read(offset, offset + 3)).readUInt32LE(0);
  }

  async u64(offset) {
    return (await this.read(offset, offset + 7)).readBigUInt64LE(0);
  }
}

export function mergeRange(ranges, [begin, end]) {
  const next = [];
  let inserted = false;
  for (const [a, b] of ranges) {
    if (b + 1 < begin) { next.push([a, b]); continue; }
    if (a > end + 1) {
      if (!inserted) { next.push([begin, end]); inserted = true; }
      next.push([a, b]);
    } else {
      begin = Math.min(begin, a);
      end = Math.max(end, b);
    }
  }
  if (!inserted) next.push([begin, end]);
  return next;
}
