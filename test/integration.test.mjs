import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
import { Store } from '../src/store.mjs';
import { inspect } from '../src/reader.mjs';

test('单件资料可解释，畸形输入被拒绝', async () => {
  const fixture = await readFile(new URL('../fixtures/primary.bin', import.meta.url));
  assert.ok(inspect(fixture));
  assert.throws(() => inspect(Buffer.alloc(0)));
});
test('来源领取、原件持久化、重启查询及无副作用拒收', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intake-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const body = JSON.stringify({ path: '/primary' });
    const send = path => fetch(`${service.url}/intakes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    const first = await send('/primary');
    assert.equal(first.status, 201);
    const record = await first.json();
    assert.deepEqual(await new Store(directory).list(), [record]);
    assert.deepEqual(Buffer.from(await (await fetch(`${service.url}/objects/${record.digest}`)).arrayBuffer()),
      await readFile(new URL('../fixtures/primary.bin', import.meta.url)));
    const repeated = await send('/primary');
    assert.equal((await repeated.json()).id, record.id);
    assert.equal((await send('/missing')).status, 422);
    assert.equal((await send('https://example.invalid/foreign')).status, 422);
    assert.equal((await new Store(directory).list()).length, 1);
    const range = await fetch(`${provider.url}/primary`, { headers: { range: 'bytes=0-0' } });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 1);
    const reject = await fetch(`${provider.url}/primary`, { headers: { 'if-match': '"old"' } });
    assert.equal(reject.status, 412);
    assert.ok(body.includes('primary'));
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('分段图定向领取：字段 provenance、区间复用、增量补领', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'projection-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  const graphRequests = async () => (await (await fetch(`${provider.url}/_requests`)).json())
    .filter(entry => entry.path === '/graph');
  const post = body => fetch(`${service.url}/projections`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const first = await post({ path: '/projection', fields: ['deviceId'] });
    assert.equal(first.status, 201);
    const deviceOnly = await first.json();
    assert.deepEqual(Object.keys(deviceOnly.fields), ['deviceId']);
    assert.equal(deviceOnly.fields.deviceId.value, '42');
    assert.deepEqual(deviceOnly.fields.deviceId.location, { segment: 1, word: 1 });
    const expectedVersion = `"${createHash('sha256')
      .update(await readFile(new URL('../fixtures/resource-01.bin', import.meta.url))).digest('hex')}"`;
    assert.equal(deviceOnly.version, expectedVersion);
    assert.equal(deviceOnly.root, `${provider.url}/graph`);
    // 根对象只经范围请求领取，且请求数不超过选择声明的边界
    const initial = await graphRequests();
    assert.ok(initial.length > 0 && initial.length <= 12);
    assert.ok(initial.every(entry => entry.headers.range));
    // 分别补领同一设备的另一字段：一次条件复核（304）加缺失区间，合入同一记录
    const second = await post({ path: '/projection', fields: ['shared'] });
    const merged = await second.json();
    assert.equal(merged.id, deviceOnly.id);
    assert.deepEqual(Object.keys(merged.fields).sort(), ['deviceId', 'shared']);
    assert.equal(merged.fields.shared.value, null);
    assert.deepEqual(merged.fields.shared.pointer, { segment: 1, word: 2 });
    const afterBackfill = await graphRequests();
    assert.equal(afterBackfill.length, initial.length + 2);
    assert.equal(afterBackfill.at(-2).headers['if-none-match'], expectedVersion);
    assert.equal(afterBackfill.at(-1).headers.range, 'bytes=40-47');
    assert.equal(afterBackfill.at(-1).headers['if-match'], expectedVersion);
    // 已核实区间被后续投影复用：仅一次条件复核（304），不再重复下载字节
    const again = await post({ path: '/projection' });
    assert.equal((await again.json()).id, deviceOnly.id);
    const reused = await graphRequests();
    assert.equal(reused.length, afterBackfill.length + 1);
    assert.equal(reused.at(-1).headers['if-none-match'], expectedVersion);
    assert.equal(reused.at(-1).headers.range, 'bytes=0-7');
    // 持久化与查询接口
    assert.deepEqual(await new Store(directory).listProjections(), [merged]);
    const fetched = await (await fetch(`${service.url}/projections/${merged.id}`)).json();
    assert.equal(fetched.id, merged.id);
    assert.equal((await fetch(`${service.url}/projections/${'0'.repeat(36)}`)).status, 404);
    // 未在选择里的字段被拒绝，不冒充空值
    assert.equal((await post({ path: '/projection', fields: ['unknown'] })).status, 422);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('源文件更换后版本失效，重新定向领取且不沿用旧解释', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'version-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  const post = body => fetch(`${service.url}/projections`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const before = await (await post({ path: '/projection', fields: ['deviceId'] })).json();
    assert.deepEqual(before.fields.deviceId.location, { segment: 1, word: 1 });
    await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 1 }) });
    try {
      const response = await post({ path: '/projection', fields: ['deviceId'] });
      assert.equal(response.status, 201);
      const after = await response.json();
      assert.notEqual(after.version, before.version);
      assert.notEqual(after.id, before.id);
      assert.deepEqual(after.fields.deviceId.location, { segment: 0, word: 1 });
      assert.equal(after.fields.deviceId.value, '42');
      const records = await (await fetch(`${service.url}/projections`)).json();
      assert.equal(records.length, 2);
    } finally {
      await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 0 }) });
    }
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('畸形回指与越界选择被拒绝，资源边界可观察', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reject-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  const post = body => fetch(`${service.url}/projections`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const cycle = await post({ root: '/cycle',
      fields: [{ name: 'loop', kind: 'struct', pointerIndex: 0 }] });
    assert.equal(cycle.status, 422);
    assert.match((await cycle.json()).error, /capnp_object_overlap/);
    const tight = await post({ root: '/graph',
      fields: [{ name: 'deviceId', kind: 'uint64', dataWord: 0 }], maxRequests: 2 });
    assert.equal(tight.status, 422);
    assert.match((await tight.json()).error, /request_budget_exceeded/);
    const bounds = await post({ root: '/graph',
      fields: [{ name: 'ghost', kind: 'uint64', dataWord: 9 }] });
    assert.equal(bounds.status, 422);
    assert.match((await bounds.json()).error, /field_bounds/);
    const foreign = await post({ root: 'https://example.invalid/graph',
      fields: [{ name: 'x', kind: 'uint64', dataWord: 0 }] });
    assert.equal(foreign.status, 422);
    assert.deepEqual(await (await fetch(`${service.url}/projections`)).json(), []);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});
