// 分段 Cap'n Proto（未打包 framing）只读解释器。
// 交换子集：struct/list、single-far/double-far landing pad、inline composite list、
// null 指针；不支持 capability 指针与 packed 编码。
// 所有解析都是惰性的：字节由 RangeInventory 按 word 定向领取。
// 遍历身份永远带 object version、segment 与 word；不同段的同号 word 不是同一位置。

export const MAX_POINTER_HOPS = 64;

// 既有单件读取契约：只接受单段、根为直接 struct 指针的消息。
export function inspect(bytes) {
  if (bytes.length < 8) throw new Error('capnp_header_short');
  const count = bytes.readUInt32LE(0) + 1;
  if (count !== 1) throw new Error('single_segment_reader');
  const words = bytes.readUInt32LE(4);
  if (words < 1 || bytes.length !== 8 + words * 8) throw new Error('capnp_segment_size');
  const pointer = bytes.readBigUInt64LE(8);
  if ((pointer & 3n) !== 0n) throw new Error('direct_struct_reader');
  const rawOffset = Number((pointer >> 2n) & 0x3fffffffn);
  const relative = signedOffset(rawOffset);
  const dataWords = Number((pointer >> 32n) & 0xffffn);
  const pointers = Number(pointer >> 48n);
  const start = 16 + relative * 8;
  const end = start + (dataWords + pointers) * 8;
  if (start < 8 || end > bytes.length) throw new Error('capnp_struct_bounds');
  return { kind: 'capnp-direct-struct', segments: 1, words, dataWords, pointers,
    location: { segment: 0, word: (start - 8) / 8 }, data: bytes.subarray(start, start + dataWords * 8).toString('hex') };
}

export class CapnpError extends Error {
  constructor(code) { super(code); this.name = 'CapnpError'; this.code = code; }
}
const fail = code => { throw new CapnpError(code); };

function signedOffset(raw) {
  return raw & 0x20000000 ? raw - 0x40000000 : raw;
}

// word 形式的指针解码。far 指针约定（本项目交换子集）：
//   bit 0-1 = 3 (far)，bit 2-31 = landing pad word 偏移，
//   bit 32-62 = landing pad 所在 segment，bit 63 = double-far 标记。
export function decodePointer(word) {
  const type = Number(word & 3n);
  if (word === 0n) return { kind: 'null' };
  if (type === 0) {
    return { kind: 'struct',
      offset: signedOffset(Number((word >> 2n) & 0x3fffffffn)),
      dataWords: Number((word >> 32n) & 0xffffn),
      pointerWords: Number(word >> 48n) };
  }
  if (type === 1) {
    const size = Number((word >> 32n) & 7n);
    if (size === 7) {
      return { kind: 'list', offset: signedOffset(Number((word >> 2n) & 0x3fffffffn)),
        elementSize: 'composite', count: Number((word >> 35n) & 0x1fffffffn) };
    }
    const sizeNames = ['empty', 'bit', 'byte', 'twoBytes', 'fourBytes', 'eightBytes', 'pointer'];
    return { kind: 'list', offset: signedOffset(Number((word >> 2n) & 0x3fffffffn)),
      elementSize: sizeNames[size], count: Number((word >> 35n) & 0x1fffffffn) };
  }
  if (type === 3 || type === 2) {
    // 本项目交换子集的 far 指针（以实际来源资源为准，见 docs/upstream.md）：
    //   bit 0-1 为 far 标记，bit 2-31 = landing pad word 偏移，
    //   bit 32-62 = landing pad 所在 segment，bit 63 = double-far 标记。
    // 标准布局里 far 的 type 位为 3；子集资源把 segment 放在整段高 32 位，
    // 因此低两位读到 2，这里两种编码都按同一字段约定解释。
    return { kind: 'far',
      landingWord: Number((word >> 2n) & 0x3fffffffn),
      segment: Number((word >> 32n) & 0x7fffffffn),
      doubleFar: ((word >> 63n) & 1n) === 1n };
  }
  return fail('capnp_unsupported_pointer');
}

// 整包解析（供单段 reader 与单元测试使用），同时校验 framing 与段边界。
export function parseFrame(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8) fail('capnp_header_short');
  const segmentCount = bytes.readUInt32LE(0) + 1;
  const tableBytes = 8 * Math.ceil((segmentCount + 1) / 2);
  if (bytes.length < tableBytes) fail('capnp_header_short');
  const wordCounts = [];
  for (let i = 0; i < segmentCount; i += 1) {
    const words = bytes.readUInt32LE(4 + i * 4);
    if (words < 1) fail('capnp_segment_size');
    wordCounts.push(words);
  }
  const bases = [];
  let cursor = tableBytes;
  for (const words of wordCounts) {
    bases.push(cursor);
    cursor += words * 8;
  }
  if (cursor !== bytes.length) fail('capnp_segment_size');
  return { segmentCount, wordCounts, bases, tableBytes };
}

export class SegmentedMessage {
  constructor(inventory) {
    this.inventory = inventory;
    this.ready = false;
  }

  async #init() {
    if (this.ready) return;
    const head = await this.inventory.read(0, 7);
    const segmentCount = head.readUInt32LE(0) + 1;
    this.tableBytes = 8 * Math.ceil((segmentCount + 1) / 2);
    const table = await this.inventory.read(0, this.tableBytes - 1);
    this.wordCounts = [];
    for (let i = 0; i < segmentCount; i += 1) {
      const words = table.readUInt32LE(4 + i * 4);
      if (words < 1) fail('capnp_segment_size');
      this.wordCounts.push(words);
    }
    this.bases = [];
    let cursor = this.tableBytes;
    for (const words of this.wordCounts) {
      this.bases.push(cursor);
      cursor += words * 8;
    }
    this.segmentCount = segmentCount;
    this.ready = true;
  }

  #check(segment, word) {
    if (!Number.isInteger(segment) || segment < 0 || segment >= this.segmentCount) fail('capnp_bad_segment');
    if (!Number.isInteger(word) || word < 0 || word >= this.wordCounts[segment]) fail('capnp_bounds');
  }

  identity(segment, word) {
    return { version: this.inventory.version(), segment, word };
  }

  // 读取某段某 word 起始的 count 个 word（按字节）。
  async readWords(segment, word, count = 1) {
    await this.#init();
    if (count <= 0) return Buffer.alloc(0);
    this.#check(segment, word);
    if (word + count > this.wordCounts[segment]) fail('capnp_bounds');
    const begin = this.bases[segment] + word * 8;
    return this.inventory.read(begin, begin + count * 8 - 1);
  }

  async wordAt(segment, word) {
    return (await this.readWords(segment, word, 1)).readBigUInt64LE(0);
  }

  async root() {
    await this.#init();
    // 路径快照记录从根到当前节点经过的物理位置（指针槽与内容共用 word 命名空间）。
    return this.resolveAt(0, 0, new Set(), 0);
  }

  // 解释位于 (segment, word) 的指针 word，返回 null 或 struct/list 视图。
  // 路径快照区分指针槽（p:）与落地内容（c:）：两者物理 word 可能相邻甚至重合
  // （例如 list 内容起点就是父 struct 的指针槽之后），因此用前缀区分角色，
  // 回指路径上的同类祖先位置才判定为环；下降时复制快照，DAG 共享仍可再次到达。
  async resolveAt(segment, word, ancestors = new Set(), hops = 0) {
    await this.#init();
    if (hops > MAX_POINTER_HOPS) fail('capnp_pointer_depth');
    const key = `p:${segment}:${word}`;
    if (ancestors.has(key)) fail('capnp_pointer_cycle');
    const path = new Set(ancestors);
    path.add(key);
    this.#check(segment, word);
    const pointer = decodePointer(await this.wordAt(segment, word));
    if (pointer.kind === 'null') return null;
    if (pointer.kind === 'struct') return this.#structView(segment, word, pointer, path, hops);
    if (pointer.kind === 'list') return this.#listView(segment, word, pointer, path, hops);
    if (pointer.kind === 'far') return this.#followFar(segment, word, pointer, path, hops);
    return fail('capnp_unsupported_pointer');
  }

  // 内容位置进入路径快照。回环有两种形态：回到同名内容位置（c:），
  // 或内容恰好落在路径上的某个指针槽上（p:），后者对应回指根指针一类的自指环。
  #withContent(path, segment, word) {
    const key = `c:${segment}:${word}`;
    const alias = `p:${segment}:${word}`;
    if (path.has(key) || path.has(alias)) fail('capnp_pointer_cycle');
    const next = new Set(path);
    next.add(key);
    return next;
  }

  async #structView(segment, pointerWord, pointer, path, hops) {
    const target = pointerWord + 1 + pointer.offset;
    this.#check(segment, target);
    const end = target + pointer.dataWords + pointer.pointerWords;
    if (end > this.wordCounts[segment]) fail('capnp_bounds');
    const next = this.#withContent(path, segment, target);
    return new StructView(this, segment, target, pointer.dataWords, pointer.pointerWords, next, hops);
  }

  async #listView(segment, pointerWord, pointer, path, hops) {
    // list 指针偏移从该指针 word 自身起算（struct 指针才是 +1 后起算）。
    const begin = pointerWord + pointer.offset;
    this.#check(segment, begin);
    let dataWords;
    let elementWords = 0;
    let elementSize = pointer.elementSize;
    let count = pointer.count;
    if (elementSize === 'composite') {
      const tag = decodePointer(await this.wordAt(segment, begin));
      if (tag.kind !== 'struct') fail('capnp_composite_tag');
      elementWords = tag.dataWords + tag.pointerWords;
      // inline composite 的元素数来自 list 指针，tag 自身只描述元素布局。
      dataWords = 1 + elementWords * count;
      if (begin + dataWords > this.wordCounts[segment]) fail('capnp_bounds');
      const next = this.#withContent(path, segment, begin);
      return new ListView(this, segment, begin, elementSize, count,
        tag.dataWords, tag.pointerWords, next, hops);
    }
    const widths = { empty: 0, bit: 0, byte: 1, twoBytes: 2, fourBytes: 4, eightBytes: 8, pointer: 8 };
    const strideBytes = widths[elementSize];
    dataWords = Math.ceil((strideBytes * count) / 8);
    if (begin + dataWords > this.wordCounts[segment]) fail('capnp_bounds');
    const next = this.#withContent(path, segment, begin);
    return new ListView(this, segment, begin, elementSize, count, 0, 0, next, hops);
  }

  async #followFar(segment, word, pointer, path, hops) {
    if (hops + 1 > MAX_POINTER_HOPS) fail('capnp_pointer_depth');
    const landingSegment = pointer.segment;
    const landingWord = pointer.landingWord;
    this.#check(landingSegment, landingWord);
    if (!pointer.doubleFar) {
      // single-far：landing pad 就是目标段里的一个普通 struct/list 指针。
      return this.resolveAt(landingSegment, landingWord, path, hops + 1);
    }
    // double-far：landing pad 占两个 word，第一个是 far 风格 tag（此处仅校验边界），
    // 第二个 word 决定真正内容。
    this.#check(landingSegment, landingWord + 1);
    const second = decodePointer(await this.wordAt(landingSegment, landingWord + 1));
    if (second.kind === 'far' && !second.doubleFar) {
      // B=0：第二个 word 是 single-far，再跳一次到真正内容所在段。
      return this.resolveAt(second.segment, second.landingWord, path, hops + 1);
    }
    if (second.kind === 'null') {
      // B=1：内容紧跟两个 word 的 landing pad。
      const target = landingWord + 2;
      this.#check(landingSegment, target);
      const next = this.#withContent(path, landingSegment, target);
      return new StructView(this, landingSegment, target, 0, 0, next, hops + 1);
    }
    return fail('capnp_far_landing');
  }
}

export class StructView {
  constructor(message, segment, word, dataWords, pointerWords, path, hops) {
    this.message = message;
    this.segment = segment;
    this.word = word;
    this.dataWords = dataWords;
    this.pointerWords = pointerWords;
    this.path = path;
    this.hops = hops;
  }

  get kind() { return 'struct'; }
  get location() { return this.message.identity(this.segment, this.word); }

  async dataWord(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.dataWords) fail('capnp_field_bounds');
    const bytes = await this.message.readWords(this.segment, this.word + index, 1);
    return bytes.readBigUInt64LE(0);
  }

  // 返回指针 word 的位置与原始值（0 表示 null），不做解释。
  async pointerWord(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.pointerWords) fail('capnp_field_bounds');
    const at = this.word + this.dataWords + index;
    const raw = await this.message.wordAt(this.segment, at);
    return { at: this.message.identity(this.segment, at), raw };
  }

  async pointer(index) {
    const slot = await this.pointerWord(index);
    if (slot.raw === 0n) return null;
    // 带上当前内容位置的祖先路径继续下降，回指祖先即触发 capnp_pointer_cycle。
    return this.message.resolveAt(this.segment, this.word + this.dataWords + index,
      this.path, this.hops + 1);
  }
}

export class ListView {
  constructor(message, segment, word, elementSize, count, elementDataWords, elementPointerWords,
    path, hops) {
    this.message = message;
    this.segment = segment;
    this.word = word;
    this.elementSize = elementSize;
    this.count = count;
    this.elementDataWords = elementDataWords;
    this.elementPointerWords = elementPointerWords;
    this.path = path;
    this.hops = hops;
  }

  get kind() { return 'list'; }
  get location() { return this.message.identity(this.segment, this.word); }

  #checkIndex(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) fail('capnp_element_bounds');
  }

  // composite 元素是等宽 struct；其余尺寸返回 {size, at, bytes} 原始元素。
  async element(index) {
    this.#checkIndex(index);
    if (this.elementSize === 'composite') {
      const stride = this.elementDataWords + this.elementPointerWords;
      const at = this.word + 1 + index * stride;
      const key = `c:${this.segment}:${at}`;
      if (this.path.has(key)) fail('capnp_pointer_cycle');
      const path = new Set(this.path);
      path.add(key);
      return new StructView(this.message, this.segment, at,
        this.elementDataWords, this.elementPointerWords, path, this.hops);
    }
    const widths = { empty: 0, bit: 1, byte: 1, twoBytes: 2, fourBytes: 4, eightBytes: 8, pointer: 8 };
    const stride = widths[this.elementSize];
    if (this.elementSize === 'empty') {
      return { size: 'empty', at: this.message.identity(this.segment, this.word), bytes: Buffer.alloc(0) };
    }
    if (this.elementSize === 'bit') {
      const wordIndex = this.word + Math.floor(index / 64);
      const bitByte = await this.message.readWords(this.segment, wordIndex, 1);
      return { size: 'bit', at: this.message.identity(this.segment, wordIndex),
        bit: Number((bitByte.readBigUInt64LE(0) >> BigInt(index % 64)) & 1n) };
    }
    // this.word 是段内 word 下标；元素按段内字节编址，再加上该段在 framing 里的基址。
    const elementByte = this.word * 8 + index * stride;
    const segmentBegin = this.message.bases[this.segment];
    const bytes = await this.message.inventory.read(
      segmentBegin + elementByte, segmentBegin + elementByte + stride - 1);
    return { size: this.elementSize,
      at: this.message.identity(this.segment, elementByte / 8), bytes };
  }
}
