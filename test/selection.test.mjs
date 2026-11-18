import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'selection-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  return {
    directory, provider, service,
    post: (body) => fetch(`${service.url}/selections`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    cleanup: async () => { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

const graphRequests = async provider =>
  (await (await fetch(`${provider.url}/_requests`)).json()).filter(r => r.path.startsWith('/graph'));

test('跨段 far 指针字段可领取，结果带版本与段内位置', async () => {
  const h = await harness();
  try {
    const response = await h.post({ path: '/projection', fields: ['deviceId'] });
    assert.equal(response.status, 201);
    const record = await response.json();
    assert.equal(record.root, '/graph');
    assert.ok(record.version.startsWith('"'));
    // 根经 far 指针落在 segment 1，而非 segment 0 的同号 word。
    assert.deepEqual(record.rootLocation, { version: record.version, segment: 1, word: 1 });
    const device = record.fields.deviceId;
    assert.equal(device.status, 'present');
    assert.equal(device.value, '42');
    assert.deepEqual(device.location, { version: record.version, segment: 1, word: 1 });
  } finally { await h.cleanup(); }
});

test('分别补领同一设备字段不会重复下载已核实区间', async () => {
  const h = await harness();
  try {
    const first = await (await h.post({ path: '/projection', fields: ['deviceId'] })).json();
    // 数据区间请求 = 除版本探测（bytes=0-0）之外的 Range 领取。
    const dataRequests = async () => (await graphRequests(h.provider))
      .filter(r => r.headers.range !== 'bytes=0-0');
    const afterFirst = (await dataRequests()).length;
    assert.ok(afterFirst >= 1);
    // 第二次只补领 shared；已核实字节由清单复用，不应再产生数据区间请求。
    const second = await (await h.post({ path: '/projection', fields: ['shared'] })).json();
    const afterSecond = (await dataRequests()).length;
    assert.equal(afterSecond, afterFirst, 'shared 补领复用已核实字节，无新增数据区间请求');
    // 每次选择仍做一次轻量版本探测，这是版本校验而非数据重下。
    const probes = (await graphRequests(h.provider)).filter(r => r.headers.range === 'bytes=0-0');
    assert.equal(probes.length, 2);
    const shared = second.fields.shared;
    assert.equal(shared.status, 'null');
    assert.deepEqual(shared.location, { version: first.version, segment: 1, word: 2 });
    assert.equal(second.version, first.version);
  } finally { await h.cleanup(); }
});

test('null 指针与尚未领取字段严格区分，未领取不冒充空值', async () => {
  const h = await harness();
  try {
    const created = await (await h.post({ path: '/projection', fields: ['deviceId'] })).json();
    // shared 尚未领取：字段详情返回 404，而不是 null。
    const missing = await fetch(`${h.service.url}/projections/${created.id}/fields/shared`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'field_not_selected');
    // 投影整体里也没有 shared 键。
    const projection = await (await fetch(`${h.service.url}/projections/${created.id}`)).json();
    assert.ok(!('shared' in projection.fields));
    assert.ok('deviceId' in projection.fields);
    // 未知投影 id 返回 404。
    assert.equal((await fetch(`${h.service.url}/projections/nonexistent-id`)).status, 404);
  } finally { await h.cleanup(); }
});

test('全部字段一次领取，struct 指针字段保留目标位置与 null 状态', async () => {
  const h = await harness();
  try {
    const record = await (await h.post({ path: '/projection' })).json();
    assert.deepEqual(Object.keys(record.fields).sort(), ['deviceId', 'shared']);
    assert.equal(record.fields.deviceId.value, '42');
    assert.equal(record.fields.shared.status, 'null');
    assert.equal(record.fields.shared.kind, 'struct');
  } finally { await h.cleanup(); }
});

test('畸形回指资源被拒绝为 422，不会无限追下去', async () => {
  const h = await harness();
  try {
    const descriptor = { root: '/cycle',
      fields: [{ name: 'loop', kind: 'struct', pointerIndex: 0 }],
      maxWords: 128, maxRequests: 16 };
    const response = await fetch(`${h.service.url}/selections`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ descriptor }) });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error, 'capnp_pointer_cycle');
  } finally { await h.cleanup(); }
});

test('请求预算越界返回明确错误码，不静默截断', async () => {
  const h = await harness();
  try {
    const descriptor = { root: '/graph',
      fields: [{ name: 'deviceId', kind: 'uint64', dataWord: 0 }],
      maxWords: 128, maxRequests: 1 };
    const response = await fetch(`${h.service.url}/selections`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ descriptor }) });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error, 'selection_request_budget');
  } finally { await h.cleanup(); }
});

test('字预算越界返回明确错误码', async () => {
  const h = await harness();
  try {
    const descriptor = { root: '/graph',
      fields: [{ name: 'deviceId', kind: 'uint64', dataWord: 0 }],
      maxWords: 1, maxRequests: 16 };
    const response = await fetch(`${h.service.url}/selections`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ descriptor }) });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error, 'selection_word_budget');
  } finally { await h.cleanup(); }
});

test('描述符字段超出根结构边界时拒绝，不返回编造的空值', async () => {
  const h = await harness();
  try {
    const descriptor = { root: '/graph',
      fields: [{ name: 'ghost', kind: 'uint64', dataWord: 9 }],
      maxWords: 128, maxRequests: 16 };
    const response = await fetch(`${h.service.url}/selections`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ descriptor }) });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error, 'capnp_field_bounds');
  } finally { await h.cleanup(); }
});

test('内联描述符不得指向配置来源之外的地址', async () => {
  const h = await harness();
  try {
    const descriptor = { root: 'https://example.invalid/graph',
      fields: [{ name: 'deviceId', kind: 'uint64', dataWord: 0 }],
      maxWords: 128, maxRequests: 16 };
    const response = await fetch(`${h.service.url}/selections`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ descriptor }) });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error, 'outside_source');
  } finally { await h.cleanup(); }
});

test('来源版本更换后旧指针解释失效，条件请求返回版本冲突', async () => {
  const h = await harness();
  try {
    const before = await (await h.post({ path: '/projection', fields: ['deviceId'] })).json();
    assert.equal(before.fields.deviceId.value, '42');
    // 切换来源阶段：/graph 字节改变，ETag 改变。
    const phase = await fetch(`${h.provider.url}/_phase`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phase: 1 }) });
    assert.equal(phase.status, 200);
    // 服务内清单按旧 ETag 发 If-Match；新版本下应得到 409 版本冲突，而不是沿用旧值。
    const conflict = await h.post({ path: '/projection', fields: ['deviceId'] });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error, 'source_version_changed');
    // 切回阶段 0 后版本恢复，可正常领取且值为 42。
    await fetch(`${h.provider.url}/_phase`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phase: 0 }) });
    const again = await (await h.post({ path: '/projection', fields: ['deviceId'] })).json();
    assert.equal(again.fields.deviceId.value, '42');
  } finally { await h.cleanup(); }
});

test('所有区间请求都带 Range 且同版本带 If-Match，不做整包下载', async () => {
  const h = await harness();
  try {
    await h.post({ path: '/projection', fields: ['deviceId'] });
    const ranges = await graphRequests(h.provider);
    assert.ok(ranges.length >= 1);
    for (const request of ranges) {
      assert.match(request.headers.range ?? '', /^bytes=\d+-\d+$/);
    }
    // 首个请求建立版本后，后续请求必须携带 If-Match。
    const later = ranges.slice(1);
    assert.ok(later.every(r => r.headers['if-match']));
  } finally { await h.cleanup(); }
});

test('投影持久化，重启后仍可读取已保存字段与溯源信息', async () => {
  const h = await harness();
  const directory = h.directory;
  const created = await (await h.post({ path: '/projection', fields: ['deviceId'] })).json();
  await h.service.close();
  const restarted = await startService({ source: h.provider.url, directory });
  try {
    const loaded = await (await fetch(`${restarted.url}/projections/${created.id}`)).json();
    assert.equal(loaded.id, created.id);
    assert.equal(loaded.fields.deviceId.value, '42');
    assert.equal(loaded.rootLocation.segment, 1);
    assert.ok(loaded.version.startsWith('"'));
  } finally { await restarted.close(); await h.provider.close(); await rm(directory, { recursive: true, force: true }); }
});
