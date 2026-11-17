import { MessageCursor } from './capnp.mjs';

const DEFAULT_LIMITS = { maxWords: 1024, maxRequests: 64 };
const KINDS = new Set(['uint64', 'struct', 'list']);

// 校验投影选择：root 为来源内路径，fields 描述所需 dataWord/pointerIndex。
// 未知字段种类被拒绝，未领取的字段不会出现在结果里（也不会冒充空值）。
export function validateSelection(raw) {
  if (raw === null || typeof raw !== 'object') throw new Error('selection_invalid');
  if (typeof raw.root !== 'string' || raw.root.length === 0) throw new Error('selection_root_required');
  if (!Array.isArray(raw.fields) || raw.fields.length === 0) throw new Error('selection_fields_required');
  const fields = new Map();
  for (const field of raw.fields) {
    if (field === null || typeof field !== 'object' || typeof field.name !== 'string' || field.name === '') {
      throw new Error('selection_field_invalid');
    }
    if (fields.has(field.name)) throw new Error('selection_field_duplicate');
    if (!KINDS.has(field.kind)) throw new Error('selection_field_kind');
    const spec = { name: field.name, kind: field.kind };
    if (field.kind === 'uint64') {
      if (!Number.isInteger(field.dataWord) || field.dataWord < 0) throw new Error('selection_field_invalid');
      spec.dataWord = field.dataWord;
    } else {
      if (!Number.isInteger(field.pointerIndex) || field.pointerIndex < 0) throw new Error('selection_field_invalid');
      spec.pointerIndex = field.pointerIndex;
    }
    fields.set(field.name, spec);
  }
  const limits = { ...DEFAULT_LIMITS };
  for (const key of ['maxWords', 'maxRequests']) {
    if (raw[key] === undefined) continue;
    if (!Number.isInteger(raw[key]) || raw[key] < 1) throw new Error('selection_limits_invalid');
    limits[key] = raw[key];
  }
  return { root: raw.root, fields, limits };
}

// 在已打开会话上执行投影；返回 { fields }，字段值均可定位到 segment/word。
export async function project(session, selection) {
  const cursor = await MessageCursor.open(session);
  const root = await cursor.root();
  if (root.kind !== 'struct') throw new Error('root_not_struct');
  const specs = [...selection.fields.values()];
  const dataWords = specs.filter(spec => spec.kind === 'uint64').map(spec => spec.dataWord);
  const pointerIndexes = specs.filter(spec => spec.kind !== 'uint64').map(spec => spec.pointerIndex);
  for (const index of dataWords) if (index >= root.dataWords) throw new Error('field_bounds');
  for (const index of pointerIndexes) if (index >= root.pointerCount) throw new Error('field_bounds');
  // 合并相邻区间，一次读取根结构所需的数据词与指针词。
  const spans = [];
  if (dataWords.length) spans.push([Math.min(...dataWords), Math.max(...dataWords) + 1]);
  if (pointerIndexes.length) {
    spans.push([root.dataWords + Math.min(...pointerIndexes), root.dataWords + Math.max(...pointerIndexes) + 1]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const span of spans) {
    if (merged.length && span[0] <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], span[1]);
    } else merged.push([...span]);
  }
  const content = new Map();
  for (const [start, end] of merged) {
    const bytes = await cursor.words(root.location.segment, root.location.word + start, end - start);
    for (let index = start; index < end; index += 1) {
      content.set(index, bytes.readBigUInt64LE((index - start) * 8));
    }
  }
  const result = {};
  for (const spec of specs) {
    if (spec.kind === 'uint64') {
      result[spec.name] = { kind: 'uint64', value: content.get(spec.dataWord).toString(),
        location: { segment: root.location.segment, word: root.location.word + spec.dataWord } };
    } else {
      const word = root.location.word + root.dataWords + spec.pointerIndex;
      const at = { segment: root.location.segment, word };
      cursor.claimPointer(at.segment, at.word);
      const target = await cursor.resolveWord(content.get(root.dataWords + spec.pointerIndex), at);
      result[spec.name] = spec.kind === 'struct'
        ? await structField(cursor, target, at)
        : await listField(cursor, target, at);
    }
  }
  return { fields: result };
}

async function structField(cursor, target, at) {
  if (target.kind === 'null') return { kind: 'struct', value: null, pointer: at, location: null };
  if (target.kind !== 'struct') throw new Error('field_kind_mismatch');
  const data = target.dataWords
    ? await cursor.words(target.location.segment, target.location.word, target.dataWords)
    : Buffer.alloc(0);
  const values = [];
  for (let index = 0; index < target.dataWords; index += 1) {
    values.push(data.readBigUInt64LE(index * 8).toString());
  }
  return { kind: 'struct', pointer: at, location: target.location,
    value: { dataWords: values, pointerCount: target.pointerCount, location: target.location } };
}

async function listField(cursor, target, at) {
  if (target.kind === 'null') return { kind: 'list', value: null, pointer: at, location: null };
  if (target.kind !== 'list') throw new Error('field_kind_mismatch');
  const { segment, word } = target.location;
  if (target.elementSize === 7) {
    const tag = await cursor.compositeTag(target);
    const bytes = tag.elementCount * tag.stride
      ? await cursor.words(segment, word + 1, tag.elementCount * tag.stride)
      : Buffer.alloc(0);
    const elements = [];
    for (let index = 0; index < tag.elementCount; index += 1) {
      const base = index * tag.stride;
      const dataWords = [];
      for (let offset = 0; offset < tag.dataWords; offset += 1) {
        dataWords.push(bytes.readBigUInt64LE((base + offset) * 8).toString());
      }
      elements.push({ dataWords, pointerCount: tag.pointerCount,
        location: { segment, word: word + 1 + base } });
    }
    return { kind: 'list', pointer: at, location: target.location,
      value: { elementSize: 7, count: tag.elementCount, elements, location: target.location } };
  }
  if (target.elementSize === 0) {
    return { kind: 'list', pointer: at, location: target.location,
      value: { elementSize: 0, count: target.count, location: target.location } };
  }
  if (target.elementSize === 6) {
    const elements = [];
    for (let index = 0; index < target.count; index += 1) {
      const element = await cursor.resolve(segment, word + index);
      elements.push(describe(element));
    }
    return { kind: 'list', pointer: at, location: target.location,
      value: { elementSize: 6, count: target.count, elements, location: target.location } };
  }
  const bits = [0, 1, 8, 16, 32, 64][target.elementSize];
  const words = Math.ceil(target.count * bits / 64);
  const bytes = words ? await cursor.words(segment, word, words) : Buffer.alloc(0);
  const elements = [];
  for (let index = 0; index < target.count; index += 1) {
    elements.push(readElement(bytes, index, target.elementSize));
  }
  return { kind: 'list', pointer: at, location: target.location,
    value: { elementSize: target.elementSize, count: target.count, elements, location: target.location } };
}

// 指针列表元素只解析一层身份，不深入其内容；未领取的内容不以空值冒充。
function describe(element) {
  if (element.kind === 'null') return { kind: 'null', pointer: element.pointer };
  if (element.kind === 'struct') {
    return { kind: 'struct', location: element.location,
      dataWords: element.dataWords, pointerCount: element.pointerCount };
  }
  return { kind: 'list', location: element.location, elementSize: element.elementSize,
    count: element.elementSize === 7 ? element.compositeWords : element.count };
}

function readElement(bytes, index, elementSize) {
  if (elementSize === 1) return (bytes[index >> 3] >> (index & 7)) & 1;
  if (elementSize === 2) return bytes[index];
  if (elementSize === 3) return bytes.readUInt16LE(index * 2);
  if (elementSize === 4) return bytes.readUInt32LE(index * 4);
  return bytes.readBigUInt64LE(index * 8).toString();
}
