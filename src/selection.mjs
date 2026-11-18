import { acquire } from './transport.mjs';
import { RangeInventory } from './inventory.mjs';
import { SegmentedMessage, CapnpError } from './reader.mjs';

// 投影选择：从描述符给出的根对象定向领取所需字段。
// 字节清单按 source + version 复用；同一 selection 重复补领字段不会重复下载已核实区间。
export class SelectionContext {
  constructor({ base, descriptor, fetcher = acquire, inventories } = {}) {
    validateDescriptor(descriptor);
    this.base = base;
    this.descriptor = descriptor;
    this.fetcher = fetcher;
    this.inventories = inventories;
  }

  #inventoryKey(etag) {
    return `${new URL(this.descriptor.root, this.base).href}|${etag}`;
  }

  #pathKey() {
    return new URL(this.descriptor.root, this.base).href;
  }

  // 先确认根对象版本（只取 framing 首字节的区间请求，携带 ETag），
  // 再返回绑定该版本的清单与消息；不做整包下载。
  async #open() {
    // 同一根路径此前已确认过版本时，强制带 If-Match：来源换文件即 412，
    // 旧清单不会被新字节沿用，指针解释仍绑定旧版本身份。
    const knownVersion = this.inventories.versionFor?.(this.#pathKey()) ?? null;
    const headers = knownVersion
      ? { 'If-Match': knownVersion, Range: 'bytes=0-0' }
      : { Range: 'bytes=0-0' };
    let probe;
    try {
      probe = await this.fetcher(this.base, this.descriptor.root, headers);
    } catch (error) {
      if (error.message === 'source_version_changed') {
        const conflict = new CapnpError('source_version_changed');
        conflict.rootPath = this.#pathKey();
        throw conflict;
      }
      throw error;
    }
    if (probe.status !== 206 && probe.status !== 200) {
      throw new CapnpError(`source_status_${probe.status}`);
    }
    const etag = probe.headers.etag;
    if (!etag) throw new CapnpError('source_version_missing');
    if (knownVersion && etag !== knownVersion) {
      const error = new CapnpError('source_version_changed');
      error.rootPath = this.#pathKey();
      throw error;
    }
    const key = this.#inventoryKey(etag);
    let inventory = this.inventories.get(key);
    if (!inventory) {
      inventory = new RangeInventory({
        base: this.base, path: this.descriptor.root,
        maxWords: this.descriptor.maxWords, maxRequests: this.descriptor.maxRequests,
        fetch: rangeFetch(this.fetcher),
      });
      inventory.etag = etag;
      inventory.absorbProbe(probe);
      this.inventories.set(key, inventory);
      this.inventories.noteVersion?.(this.#pathKey(), etag);
    }
    return { inventory, message: new SegmentedMessage(inventory), version: etag };
  }

  async select(fieldNames) {
    const wanted = normalizeFields(this.descriptor, fieldNames);
    const { message, version, inventory } = await this.#open();
    const root = await message.root();
    if (root === null) throw new CapnpError('capnp_root_null');
    const fields = {};
    for (const field of wanted) fields[field.name] = await readField(message, root, field);
    return {
      root: this.descriptor.root,
      version,
      rootLocation: root.location,
      descriptor: descriptorSummary(this.descriptor),
      fields,
      budgets: { requestsUsed: inventory.requestsUsed, wordsUsed: inventory.wordsUsed,
        maxRequests: inventory.maxRequests, maxWords: inventory.maxWords },
    };
  }
}

export function validateDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') throw new CapnpError('descriptor_invalid');
  if (typeof descriptor.root !== 'string' || !descriptor.root.startsWith('/')) {
    throw new CapnpError('descriptor_root_required');
  }
  if (!Array.isArray(descriptor.fields) || descriptor.fields.length === 0) {
    throw new CapnpError('descriptor_fields_required');
  }
  for (const field of descriptor.fields) {
    if (typeof field.name !== 'string' || !field.name) throw new CapnpError('descriptor_field_name');
    if (field.kind === 'uint64') {
      if (!Number.isInteger(field.dataWord) || field.dataWord < 0) throw new CapnpError('descriptor_field_index');
    } else if (field.kind === 'struct' || field.kind === 'list') {
      if (!Number.isInteger(field.pointerIndex) || field.pointerIndex < 0) {
        throw new CapnpError('descriptor_field_index');
      }
    } else {
      throw new CapnpError('descriptor_field_kind');
    }
  }
  for (const bound of ['maxWords', 'maxRequests']) {
    if (!Number.isInteger(descriptor[bound]) || descriptor[bound] <= 0) throw new CapnpError('descriptor_budget');
  }
  const names = new Set();
  for (const field of descriptor.fields) {
    if (names.has(field.name)) throw new CapnpError('descriptor_field_duplicate');
    names.add(field.name);
  }
  return descriptor;
}

function normalizeFields(descriptor, fieldNames) {
  if (fieldNames === undefined || fieldNames === null) return descriptor.fields;
  if (!Array.isArray(fieldNames) || fieldNames.some(name => typeof name !== 'string')) {
    throw new CapnpError('selection_fields_invalid');
  }
  return fieldNames.map(name => {
    const field = descriptor.fields.find(item => item.name === name);
    if (!field) throw new CapnpError('selection_field_unknown');
    return field;
  });
}

function descriptorSummary(descriptor) {
  return { root: descriptor.root, maxWords: descriptor.maxWords, maxRequests: descriptor.maxRequests,
    fields: descriptor.fields.map(({ name, kind, dataWord, pointerIndex }) =>
      ({ name, kind, dataWord, pointerIndex })) };
}

async function readField(message, root, field) {
  if (field.kind === 'uint64') {
    if (field.dataWord >= root.dataWords) throw new CapnpError('capnp_field_bounds');
    const value = await root.dataWord(field.dataWord);
    return { name: field.name, kind: 'uint64', status: 'present', value: value.toString(),
      location: message.identity(root.segment, root.word + field.dataWord) };
  }
  const slot = await root.pointerWord(field.pointerIndex);
  if (slot.raw === 0n) {
    // 明确读到 null 指针才算空；尚未领取的字段绝不会走到这里被冒充成空值。
    return { name: field.name, kind: field.kind, status: 'null', location: slot.at };
  }
  const target = await root.pointer(field.pointerIndex);
  if (target === null) {
    return { name: field.name, kind: field.kind, status: 'null', location: slot.at };
  }
  return describeTarget(field, slot, target);
}

function describeTarget(field, slot, target) {
  const base = { name: field.name, kind: field.kind, status: 'present', pointerAt: slot.at };
  if (target.kind === 'struct') {
    return { ...base, target: 'struct', location: target.location,
      dataWords: target.dataWords, pointerWords: target.pointerWords };
  }
  return { ...base, target: 'list', location: target.location,
    elementSize: target.elementSize, count: target.count,
    elementDataWords: target.elementDataWords, elementPointerWords: target.elementPointerWords };
}

// 选择清单内部使用的区间领取函数，复用调用方注入的 HTTP 领取器。
function rangeFetch(fetcher) {
  return async (base, path, { begin, end, etag }) => {
    const headers = { Range: `bytes=${begin}-${end}` };
    if (etag) headers['If-Match'] = etag;
    const response = await fetcher(base, path, headers);
    const changed = () => {
      const error = new CapnpError('source_version_changed');
      error.rootPath = new URL(path, base).href;
      return error;
    };
    if (response.status === 412) throw changed();
    if (response.status !== 206 && response.status !== 200) {
      throw new CapnpError(`source_status_${response.status}`);
    }
    const responseEtag = response.headers.etag;
    if (etag && responseEtag && responseEtag !== etag) throw changed();
    if (response.status === 206) {
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] ?? '');
      if (!match || Number(match[1]) !== begin || Number(match[2]) !== end ||
          response.bytes.length !== end - begin + 1) {
        throw new CapnpError('source_range_mismatch');
      }
      return { begin, end, bytes: response.bytes, etag: responseEtag ?? etag,
        resourceLength: Number(match[3]) };
    }
    if (response.bytes.length < end + 1) throw new CapnpError('source_range_mismatch');
    return { begin: 0, end: response.bytes.length - 1, bytes: response.bytes,
      etag: responseEtag ?? etag, resourceLength: response.bytes.length };
  };
}
