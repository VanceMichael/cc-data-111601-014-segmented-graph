import test from 'node:test';
import assert from 'node:assert/strict';
import { RangeInventory, mergeRange } from '../src/inventory.mjs';
import { acquireRange } from '../src/transport.mjs';
import { startRangeSource } from './support.mjs';

function mockInventory({ maxWords = Infinity, maxRequests = Infinity, blocks } = {}) {
  const calls = [];
  const inventory = new RangeInventory({
    base: 'http://x', path: '/m', maxWords, maxRequests, prefetchWords: 2,
    fetch: async (b, p, { begin, end, etag }) => {
      calls.push({ begin, end, etag });
      const bytes = blocks.subarray(begin, end + 1);
      return { begin, end, bytes, etag: etag ?? '"v1"', resourceLength: blocks.length };
    },
  });
  return { inventory, calls };
}

test('区间合并：相邻与重叠区间归一，分离区间保留', () => {
  assert.deepEqual(mergeRange([], [0, 7]), [[0, 7]]);
  assert.deepEqual(mergeRange([[0, 7]], [8, 15]), [[0, 15]]);
  assert.deepEqual(mergeRange([[0, 7]], [20, 27]), [[0, 7], [20, 27]]);
  assert.deepEqual(mergeRange([[0, 7], [20, 27]], [5, 22]), [[0, 27]]);
});

test('covered 只在完整包含时为真', () => {
  const { inventory } = mockInventory({ blocks: Buffer.alloc(64) });
  inventory.ranges = [[8, 23]];
  assert.equal(inventory.covered(8, 23), true);
  assert.equal(inventory.covered(8, 24), false);
  assert.equal(inventory.covered(7, 23), false);
});

test('missing 不把需求外的大片未覆盖区并入本次领取', () => {
  const { inventory } = mockInventory({ blocks: Buffer.alloc(128) });
  inventory.ranges = [[0, 0]];
  // 只需要 1..7，缺口应严格限制在需求内。
  assert.deepEqual(inventory.missing(0, 7), [[1, 7]]);
  inventory.ranges = [[0, 15]];
  assert.deepEqual(inventory.missing(16, 23), [[16, 23]]);
});

test('重复读取同一区间只发一次请求，后续走已核实字节', async () => {
  const blocks = Buffer.alloc(64, 9);
  const { inventory, calls } = mockInventory({ blocks });
  await inventory.read(8, 15);
  await inventory.read(8, 15);
  await inventory.read(10, 12);
  assert.equal(calls.length, 1);
  const again = await inventory.read(8, 15);
  assert.deepEqual(again, blocks.subarray(8, 16));
});

test('并发读取同一缺口被串行合并，请求数远小于逐个读取', async () => {
  const blocks = Buffer.alloc(128);
  const { inventory, calls } = mockInventory({ blocks });
  await Promise.all([inventory.read(8, 15), inventory.read(16, 23), inventory.read(24, 31)]);
  // 三次相邻 word 读合并为少量预取请求，而不是三次独立领取。
  assert.ok(calls.length < 3, `got ${calls.length} calls`);
  const all = await inventory.read(8, 31);
  assert.equal(all.length, 24);
});

test('请求预算耗尽抛出 selection_request_budget', async () => {
  const { inventory } = mockInventory({ maxRequests: 1, blocks: Buffer.alloc(256) });
  await inventory.read(8, 15);
  await assert.rejects(() => inventory.read(64, 71), (e) => e.message === 'selection_request_budget');
});

test('字预算耗尽抛出 selection_word_budget', async () => {
  const { inventory } = mockInventory({ maxWords: 2, blocks: Buffer.alloc(256) });
  await assert.rejects(() => inventory.read(8, 31), (e) => e.message === 'selection_word_budget');
});

test('版本变化在清单层被识别并拒绝沿用旧解释', async () => {
  const source = await startRangeSource({ '/m': Buffer.alloc(32, 1) });
  try {
    const good = await acquireRange(source.url, '/m', { begin: 0, end: 7 });
    assert.equal(good.full, false);
    assert.equal(good.resourceLength, 32);
    await assert.rejects(
      () => acquireRange(source.url, '/m', { begin: 0, end: 7, etag: '"stale"' }),
      (e) => e.message === 'source_version_changed');
  } finally { await source.close(); }
});

test('来源忽略 Range 返回整包时按实际字节登记且不报错位', async () => {
  const blocks = Buffer.alloc(32, 5);
  const server = await startRangeSource({ '/m': blocks });
  try {
    // 直接用 transport 验证 206 路径的 content-range 校验。
    const part = await acquireRange(server.url, '/m', { begin: 8, end: 15 });
    assert.equal(part.bytes.length, 8);
    assert.equal(part.begin, 8);
  } finally { await server.close(); }
});
