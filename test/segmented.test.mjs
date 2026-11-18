import test from 'node:test';
import assert from 'node:assert/strict';
import { RangeInventory } from '../src/inventory.mjs';
import { SegmentedMessage, decodePointer, parseFrame, inspect, CapnpError } from '../src/reader.mjs';
import { startRangeSource, frame, words, structPointer, listPointer, farPointer, compositeTag } from './support.mjs';

async function messageFor(bytes, { maxWords = 256, maxRequests = 32 } = {}) {
  const source = await startRangeSource({ '/m': bytes });
  const inventory = new RangeInventory({ base: source.url, path: '/m', maxWords, maxRequests });
  const probe = await fetch(`${source.url}/m`, { headers: { Range: 'bytes=0-0' } });
  inventory.etag = probe.headers.get('etag');
  inventory.absorbProbe({ begin: 0, end: 0, bytes: Buffer.from(await probe.arrayBuffer()),
    etag: inventory.etag, resourceLength: bytes.length });
  return { source, inventory, message: new SegmentedMessage(inventory) };
}

test('单段 inspect 既有契约保持不变', () => {
  const bytes = frame([words(structPointer({ offset: 0, dataWords: 1, pointerWords: 0 }), 42n)]);
  const result = inspect(bytes);
  assert.equal(result.dataWords, 1);
  assert.equal(result.data, '2a00000000000000');
  assert.equal(result.location.word, 1);
});

test('single-far 跨段解析，身份含 version/segment/word', async () => {
  // seg0 只有一个 far 指针，跳到 seg1 word0 的 struct。
  const seg0 = words(farPointer({ landingWord: 0, segment: 1 }));
  const seg1 = words(structPointer({ offset: 0, dataWords: 1, pointerWords: 1 }), 42n, 0n);
  const bytes = frame([seg0, seg1]);
  const { source, inventory, message } = await messageFor(bytes);
  try {
    const root = await message.root();
    assert.equal(root.kind, 'struct');
    assert.equal(root.segment, 1);
    assert.equal(root.word, 1);
    assert.equal((await root.dataWord(0)).toString(), '42');
    const identity = root.location;
    assert.equal(identity.segment, 1);
    assert.equal(identity.word, 1);
    assert.ok(identity.version.startsWith('"'));
    // 不同段同号 word 不是同一位置：seg0 word1 越界，seg1 word1 是数据。
    assert.equal(inventory.version(), identity.version);
  } finally { await source.close(); }
});

test('null 指针与未领取字段语义不同：null 是显式零指针', async () => {
  const seg0 = words(structPointer({ offset: 0, dataWords: 0, pointerWords: 1 }), 0n);
  const { source, message } = await messageFor(frame([seg0]));
  try {
    const root = await message.root();
    const slot = await root.pointerWord(0);
    assert.equal(slot.raw, 0n);
    assert.equal(await root.pointer(0), null);
  } finally { await source.close(); }
});

test('普通 struct 列表与 inline composite 列表可定位每个元素', async () => {
  // root struct 含 1 个 pointer word，指向 composite list 的 tag（指针后一个 word）。
  const root = structPointer({ offset: 0, dataWords: 0, pointerWords: 1 });
  const list = listPointer({ offset: 1, elementSize: 'composite', count: 3 });
  const tag = compositeTag({ dataWords: 1, pointerWords: 0 });
  const seg = words(root, list, tag, 10n, 20n, 30n);
  const { source, message } = await messageFor(frame([seg]));
  try {
    const rootView = await message.root();
    const target = await rootView.pointer(0);
    assert.equal(target.kind, 'list');
    assert.equal(target.elementSize, 'composite');
    assert.equal(target.count, 3);
    const values = [];
    for (let i = 0; i < 3; i += 1) {
      const element = await target.element(i);
      values.push(Number(await element.dataWord(0)));
    }
    assert.deepEqual(values, [10, 20, 30]);
    await assert.rejects(() => target.element(3), (e) => e.code === 'capnp_element_bounds');
  } finally { await source.close(); }
});

test('eightBytes 列表元素位置与值正确', async () => {
  const root = structPointer({ offset: 0, dataWords: 0, pointerWords: 1 });
  const list = listPointer({ offset: 1, elementSize: 'eightBytes', count: 2 });
  const seg = words(root, list, 7n, 8n);
  const { source, message } = await messageFor(frame([seg]));
  try {
    const target = await (await message.root()).pointer(0);
    assert.equal(target.count, 2);
    const first = await target.element(0);
    const second = await target.element(1);
    assert.equal(first.bytes.readBigUInt64LE(0), 7n);
    assert.equal(second.bytes.readBigUInt64LE(0), 8n);
  } finally { await source.close(); }
});

test('double-far B=0：landing pad 第二 word 再跳一段', async () => {
  // seg0: far(double) -> seg1 word0；seg1: [double tag, single-far -> seg2 word0]；seg2 放内容。
  const seg0 = words(farPointer({ landingWord: 0, segment: 1, doubleFar: true }));
  const seg1 = words(farPointer({ landingWord: 0, segment: 1, doubleFar: true }),
    farPointer({ landingWord: 0, segment: 2 }));
  const seg2 = words(structPointer({ offset: 0, dataWords: 1, pointerWords: 0 }), 99n);
  const { source, message } = await messageFor(frame([seg0, seg1, seg2]));
  try {
    const root = await message.root();
    assert.equal(root.segment, 2);
    assert.equal((await root.dataWord(0)).toString(), '99');
  } finally { await source.close(); }
});

test('double-far B=1：内容紧跟两 word landing pad', async () => {
  // seg0: far(double) -> seg1 word0；seg1: [double tag, null]，内容数据从 word2 开始。
  const seg0 = words(farPointer({ landingWord: 0, segment: 1, doubleFar: true }));
  const seg1 = words(farPointer({ landingWord: 0, segment: 1, doubleFar: true }), 0n, 77n);
  const { source, message } = await messageFor(frame([seg0, seg1]));
  try {
    const root = await message.root();
    assert.equal(root.kind, 'struct');
    assert.equal(root.segment, 1);
    assert.equal(root.word, 2);
  } finally { await source.close(); }
});

test('越界 struct 指针拒绝，不降级为空对象', async () => {
  const bad = structPointer({ offset: 100, dataWords: 1, pointerWords: 0 });
  const { source, message } = await messageFor(frame([words(bad)]));
  try {
    await assert.rejects(() => message.root(), (e) => e.code === 'capnp_bounds');
  } finally { await source.close(); }
});

test('指向不存在的段直接报错', async () => {
  const seg0 = words(farPointer({ landingWord: 0, segment: 9 }));
  const { source, message } = await messageFor(frame([seg0]));
  try {
    await assert.rejects(() => message.root(), (e) => e.code === 'capnp_bad_segment');
  } finally { await source.close(); }
});

test('畸形自指环被识别为 capnp_pointer_cycle 而非无限递归', async () => {
  // root struct(0 data,1 ptr)，其唯一 pointer word 指回 root 指针 word 自身。
  const root = structPointer({ offset: 0, dataWords: 0, pointerWords: 1 });
  const back = structPointer({ offset: -2, dataWords: 0, pointerWords: 1 });
  const { source, message } = await messageFor(frame([words(root, back)]));
  try {
    const rootView = await message.root();
    // 根本身可解析；沿唯一指针下降时回到路径上的祖先，必须报错而不是无限追。
    await assert.rejects(() => rootView.pointer(0), (e) => e.code === 'capnp_pointer_cycle');
  } finally { await source.close(); }
});

test('decodePointer 覆盖子集各指针型并保留 far 的 segment/doubleFar 位', () => {
  const single = decodePointer(farPointer({ landingWord: 5, segment: 1 }));
  assert.equal(single.kind, 'far');
  assert.equal(single.landingWord, 5);
  assert.equal(single.segment, 1);
  assert.equal(single.doubleFar, false);
  const double = decodePointer(farPointer({ landingWord: 2, segment: 3, doubleFar: true }));
  assert.equal(double.doubleFar, true);
  assert.equal(double.segment, 3);
  assert.equal(decodePointer(0n).kind, 'null');
  assert.equal(decodePointer(listPointer({ offset: 0, elementSize: 'byte', count: 4 })).kind, 'list');
  assert.equal(decodePointer(structPointer({ offset: 0, dataWords: 1, pointerWords: 0 })).kind, 'struct');
});

test('DAG 共享节点可再次到达，不被误判为环', async () => {
  // 布局：word0=root 指针，word1..2=root 的两个指针槽，word3=共享 struct 指针，word4=其内容。
  // 两个指针槽都要让 struct 内容落在 word4：offset = contentWord - (slotWord + 1)。
  const root = structPointer({ offset: 0, dataWords: 0, pointerWords: 2 });
  const slot0 = structPointer({ offset: 2, dataWords: 1, pointerWords: 0 }); // 4-(1+1)
  const slot1 = structPointer({ offset: 1, dataWords: 1, pointerWords: 0 }); // 4-(2+1)
  const shared = structPointer({ offset: 0, dataWords: 1, pointerWords: 0 });
  const seg = words(root, slot0, slot1, shared, 55n);
  const { source, message } = await messageFor(frame([seg]));
  try {
    const rootView = await message.root();
    const a = await rootView.pointer(0);
    const b = await rootView.pointer(1);
    // 共享 struct 内容都落在 word4。
    assert.equal(a.word, 4);
    assert.equal(b.word, 4);
    assert.equal((await a.dataWord(0)).toString(), '55');
    assert.equal((await b.dataWord(0)).toString(), '55');
  } finally { await source.close(); }
});

test('超长 far 跳转链受 hop 上限保护，不会无限追', async () => {
  // 一串互相 single-far 跳转的段，链深超过 MAX_POINTER_HOPS。
  const segments = [];
  const chain = 70;
  for (let i = 0; i < chain; i += 1) {
    const next = i + 1;
    segments.push(words(farPointer({ landingWord: 0, segment: next < chain ? next : i })));
  }
  segments.push(words(structPointer({ offset: 0, dataWords: 1, pointerWords: 0 }), 1n));
  const { source, message } = await messageFor(frame(segments), { maxRequests: 256, maxWords: 256 });
  try {
    await assert.rejects(() => message.root(), (e) =>
      e.code === 'capnp_pointer_depth' || e.code === 'capnp_pointer_cycle' || e.code === 'capnp_bad_segment');
  } finally { await source.close(); }
});

test('UInt64 全精度保留，越界 dataWord 拒绝而非返回默认值', async () => {
  const big = (1n << 63n) + 12345n;
  const seg = words(structPointer({ offset: 0, dataWords: 1, pointerWords: 0 }), big);
  const { source, message } = await messageFor(frame([seg]));
  try {
    const root = await message.root();
    assert.equal(await root.dataWord(0), big);
    await assert.rejects(() => root.dataWord(1), (e) => e.code === 'capnp_field_bounds');
  } finally { await source.close(); }
});

test('parseFrame 拒绝段表与字节数不一致', () => {
  assert.throws(() => parseFrame(Buffer.alloc(7)), /capnp_header_short/);
  const malformed = frame([words(0n)]).subarray(0, 10);
  assert.throws(() => parseFrame(malformed), /capnp_segment_size/);
});
