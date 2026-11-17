import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
const graphRequests = async () => (await (await fetch(`${provider.url}/_requests`)).json())
  .filter(entry => entry.path === '/graph');
const project = body => fetch(`${service.url}/projections`, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());
  const intake = await fetch(`${service.url}/intakes`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
  if (intake.status !== 201) throw new Error(await intake.text());
  console.log('单件接收结果', await intake.json());
  // 分段图定向领取：按选择描述只取所需字段与引用
  const projection = await project({ path: '/projection' });
  if (projection.status !== 201) throw new Error(await projection.text());
  console.log('定向领取结果', await projection.json());
  console.log('根对象范围请求', (await graphRequests()).map(entry => entry.headers.range));
  // 同一设备分别补领字段：已核实区间复用，仅一次条件复核
  const backfill = await project({ path: '/projection', fields: ['deviceId'] });
  console.log('补领复用区间', (await backfill.json()).id);
  // 模拟来源侧更换文件（联调控制，不由产品触发）：版本失效后重新定向领取
  await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 1 }) });
  const rotated = await project({ path: '/projection', fields: ['deviceId'] });
  console.log('源文件更换后', await rotated.json());
  await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 0 }) });
  // 畸形回指被拒绝，不当作合法树
  const cycle = await project({ root: '/cycle',
    fields: [{ name: 'loop', kind: 'struct', pointerIndex: 0 }] });
  console.log('畸形回指拒绝', cycle.status, await cycle.json());
  console.log('已保存投影', await (await fetch(`${service.url}/projections`)).json());
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
