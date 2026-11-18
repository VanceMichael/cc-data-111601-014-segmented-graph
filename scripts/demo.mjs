import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());

  // 既有能力：单件原件接收。
  const intake = await fetch(`${service.url}/intakes`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
  if (intake.status !== 201) throw new Error(await intake.text());
  console.log('单件接收', (await intake.json()).parsed.location);

  // 新能力：分段图定向领取。先只取一个设备字段，再补领另一个，复用已核实字节。
  const select = (body) => fetch(`${service.url}/selections`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const first = await (await select({ path: '/projection', fields: ['deviceId'] })).json();
  console.log('首次定向领取 deviceId', {
    value: first.fields.deviceId.value,
    rootLocation: first.rootLocation,
    requestsUsed: first.budgets.requestsUsed,
  });
  const second = await (await select({ path: '/projection', fields: ['shared'] })).json();
  console.log('补领 shared（复用已核实区间）', {
    status: second.fields.shared.status,
    location: second.fields.shared.location,
    requestsUsed: second.budgets.requestsUsed,
  });

  // 未领取字段不会被冒充成空值。
  const missing = await fetch(`${service.url}/projections/${first.id}/fields/shared`);
  console.log('首份投影读取未领取字段', missing.status, (await missing.json()).error);

  console.log('已保存原件', (await (await fetch(`${service.url}/records`)).json()).length, '件；投影根 =',
    (await (await fetch(`${service.url}/projections/${second.id}`)).json()).root);
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
