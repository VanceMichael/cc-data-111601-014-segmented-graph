// Cap'n Proto 未打包 framing 的分段读取与指针解析。
// 遍历身份 = (object version, segment, word)；version 由会话持有，此处只处理 segment/word。
// 通过区间认领拒绝别名与环：同一遍历中，被解释为指针的字与对象内容字不得互相重叠。

const WORD = 8;

export function segmentTable(head, rest) {
  if (head.length < WORD) throw new Error('capnp_header_short');
  const count = head.readUInt32LE(0) + 1;
  const tableBytes = Math.ceil((4 + 4 * count) / WORD) * WORD;
  if (rest.length !== tableBytes - WORD) throw new Error('capnp_segment_table');
  const sizes = [];
  for (let index = 0; index < count; index += 1) {
    const word = index === 0 ? head : rest;
    const at = index === 0 ? 4 : (index - 1) * 4;
    sizes.push(word.readUInt32LE(at));
  }
  const starts = [];
  let offset = tableBytes;
  for (const size of sizes) { starts.push(offset); offset += size * WORD; }
  return { count, sizes, starts, tableBytes, fileBytes: offset };
}

export class MessageCursor {
  // session.readBytes(start, endExclusive) → Buffer；session 负责词与请求预算。
  constructor(session, table) {
    this.session = session;
    this.table = table;
    this.claimedPointers = new Map(); // segment → [[start, end)]
    this.claimedContent = new Map();
  }

  static async open(session) {
    const head = await session.readBytes(0, WORD);
    if (head.length < WORD) throw new Error('capnp_header_short');
    const count = head.readUInt32LE(0) + 1;
    const tableBytes = Math.ceil((4 + 4 * count) / WORD) * WORD;
    if (tableBytes > session.limits.maxWords * WORD) throw new Error('capnp_segment_table');
    const rest = tableBytes > WORD ? await session.readBytes(WORD, tableBytes) : Buffer.alloc(0);
    return new MessageCursor(session, segmentTable(head, rest));
  }

  overlaps(map, segment, start, end) {
    return (map.get(segment) ?? []).some(([a, b]) => start < b && a < end);
  }

  claimContent(segment, start, end) {
    if (start >= end) return;
    if (this.overlaps(this.claimedContent, segment, start, end) ||
        this.overlaps(this.claimedPointers, segment, start, end)) {
      throw new Error('capnp_object_overlap');
    }
    const list = this.claimedContent.get(segment) ?? [];
    list.push([start, end]);
    this.claimedContent.set(segment, list);
  }

  claimPointer(segment, word) {
    if (this.overlaps(this.claimedPointers, segment, word, word + 1)) {
      throw new Error('capnp_object_overlap');
    }
    const list = this.claimedPointers.get(segment) ?? [];
    list.push([word, word + 1]);
    this.claimedPointers.set(segment, list);
  }

  async words(segment, word, count) {
    if (!Number.isInteger(segment) || segment < 0 || segment >= this.table.count ||
        !Number.isInteger(word) || word < 0 || word + count > this.table.sizes[segment]) {
      throw new Error('capnp_bounds');
    }
    const start = this.table.starts[segment] + word * WORD;
    return this.session.readBytes(start, start + count * WORD);
  }

  async pointerWord(segment, word) {
    return (await this.words(segment, word, 1)).readBigUInt64LE(0);
  }

  // 解析位于 (segment, word) 的指针并认领该指针字；landing pad 由 resolveFar 自行认领。
  async resolve(segment, word) {
    this.claimPointer(segment, word);
    return this.resolveWord(await this.pointerWord(segment, word), { segment, word });
  }

  // 解析已读出的指针字；调用方负责先认领指针字。
  async resolveWord(pointer, at) {
    if (pointer === 0n) return { kind: 'null', pointer: at };
    const type = Number(pointer & 3n);
    if (type === 0) return this.resolveStruct(pointer, at);
    if (type === 1) return this.resolveList(pointer, at);
    if (type === 2) return this.resolveFar(pointer, at);
    throw new Error('capnp_pointer_kind');
  }

  resolveStruct(pointer, at) {
    const offset = signedOffset(pointer);
    const dataWords = Number((pointer >> 32n) & 0xffffn);
    const pointerCount = Number(pointer >> 48n);
    const word = at.word + 1 + offset;
    return this.claimStruct(at.segment, word, dataWords, pointerCount, at);
  }

  claimStruct(segment, word, dataWords, pointerCount, pointerAt) {
    if (word < 0 || word + dataWords + pointerCount > this.table.sizes[segment]) {
      throw new Error('capnp_bounds');
    }
    this.claimContent(segment, word, word + dataWords + pointerCount);
    return { kind: 'struct', location: { segment, word }, dataWords, pointerCount, pointer: pointerAt };
  }

  resolveList(pointer, at) {
    const offset = signedOffset(pointer);
    const elementSize = Number((pointer >> 32n) & 7n);
    const count = Number(pointer >> 35n);
    const word = at.word + 1 + offset;
    if (elementSize === 7) {
      // inline composite：count 为内容词数（不含 tag），tag 为 struct 形态。
      if (word < 0 || word + 1 + count > this.table.sizes[at.segment]) throw new Error('capnp_bounds');
      this.claimContent(at.segment, word, word + 1 + count);
      return { kind: 'list', location: { segment: at.segment, word }, elementSize,
        compositeWords: count, pointer: at };
    }
    const bits = [0, 1, 8, 16, 32, 64, 64, 0][elementSize];
    const words = elementSize === 6 ? count : Math.ceil(count * bits / 64);
    if (word < 0 || word + words > this.table.sizes[at.segment]) throw new Error('capnp_bounds');
    this.claimContent(at.segment, word, word + words);
    return { kind: 'list', location: { segment: at.segment, word }, elementSize, count, pointer: at };
  }

  async resolveFar(pointer, at) {
    const isDouble = Number((pointer >> 2n) & 1n) === 1;
    const padWord = Number((pointer >> 3n) & 0x1fffffffn);
    const segment = Number(pointer >> 32n);
    if (segment >= this.table.count) throw new Error('capnp_bounds');
    const padWords = isDouble ? 2 : 1;
    if (padWord + padWords > this.table.sizes[segment]) throw new Error('capnp_bounds');
    this.claimPointer(segment, padWord);
    if (isDouble) this.claimPointer(segment, padWord + 1);
    if (!isDouble) {
      const landing = await this.pointerWord(segment, padWord);
      if (landing === 0n) return { kind: 'null', pointer: { segment, word: padWord } };
      const type = Number(landing & 3n);
      if (type === 0) return this.resolveStruct(landing, { segment, word: padWord });
      if (type === 1) return this.resolveList(landing, { segment, word: padWord });
      throw new Error('capnp_far_chain');
    }
    const far = await this.pointerWord(segment, padWord);
    const tag = await this.pointerWord(segment, padWord + 1);
    if ((far & 3n) !== 2n || Number((far >> 2n) & 1n) !== 0) throw new Error('capnp_far_chain');
    if (tag === 0n) return { kind: 'null', pointer: { segment, word: padWord + 1 } };
    const targetSegment = Number(far >> 32n);
    const targetWord = Number((far >> 3n) & 0x1fffffffn);
    if (targetSegment >= this.table.count) throw new Error('capnp_bounds');
    const tagType = Number(tag & 3n);
    const tagAt = { segment, word: padWord + 1 };
    if (tagType === 0) {
      const dataWords = Number((tag >> 32n) & 0xffffn);
      const pointerCount = Number(tag >> 48n);
      return this.claimStruct(targetSegment, targetWord, dataWords, pointerCount, tagAt);
    }
    if (tagType === 1) {
      const elementSize = Number((tag >> 32n) & 7n);
      const count = Number(tag >> 35n);
      if (elementSize === 7) {
        if (targetWord + 1 + count > this.table.sizes[targetSegment]) throw new Error('capnp_bounds');
        this.claimContent(targetSegment, targetWord, targetWord + 1 + count);
        return { kind: 'list', location: { segment: targetSegment, word: targetWord },
          elementSize, compositeWords: count, pointer: tagAt };
      }
      const bits = [0, 1, 8, 16, 32, 64, 64, 0][elementSize];
      const words = elementSize === 6 ? count : Math.ceil(count * bits / 64);
      if (targetWord + words > this.table.sizes[targetSegment]) throw new Error('capnp_bounds');
      this.claimContent(targetSegment, targetWord, targetWord + words);
      return { kind: 'list', location: { segment: targetSegment, word: targetWord },
        elementSize, count, pointer: tagAt };
    }
    throw new Error('capnp_far_chain');
  }

  async root() {
    return this.resolve(0, 0);
  }

  // inline composite 的 tag：elementCount 存放在 struct 指针的 offset 位。
  async compositeTag(list) {
    const tag = await this.pointerWord(list.location.segment, list.location.word);
    if ((tag & 3n) !== 0n) throw new Error('capnp_list_malformed');
    const elementCount = Number((tag >> 2n) & 0x3fffffffn);
    const dataWords = Number((tag >> 32n) & 0xffffn);
    const pointerCount = Number(tag >> 48n);
    const stride = dataWords + pointerCount;
    if (elementCount * stride > list.compositeWords) throw new Error('capnp_list_malformed');
    return { elementCount, dataWords, pointerCount, stride };
  }
}

function signedOffset(pointer) {
  const raw = Number((pointer >> 2n) & 0x3fffffffn);
  return raw & 0x20000000 ? raw - 0x40000000 : raw;
}
