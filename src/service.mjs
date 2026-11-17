import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { acquire } from './transport.mjs';
import { inspect } from './reader.mjs';
import { RangeSource } from './ranges.mjs';
import { validateSelection, project } from './projection.mjs';

async function readJson(request, limit = 16384) {
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

// 分段图定向领取：先取选择描述（含 root 与字段），再对根对象按范围请求定向领取。
// 同一来源的多次投影复用已核实区间；版本变化时整轮重取，不混用新旧解释。
async function runProjection(source, ranges, payload) {
  let selection;
  if (typeof payload.path === 'string') {
    if (payload.root !== undefined) throw new Error('selection_ambiguous');
    const descriptor = JSON.parse((await acquire(source, payload.path)).bytes.toString());
    selection = validateSelection(descriptor);
    if (payload.fields !== undefined) {
      if (!Array.isArray(payload.fields) || payload.fields.length === 0) throw new Error('fields_filter_invalid');
      const unknown = payload.fields.filter(name => !selection.fields.has(name));
      if (unknown.length) throw new Error('unknown_fields');
      selection.fields = new Map([...selection.fields].filter(([name]) => payload.fields.includes(name)));
    }
  } else {
    selection = validateSelection(payload);
  }
  const counters = { words: 0, requests: 0 };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const session = ranges.session(selection.root, selection.limits, counters);
    try {
      const { fields } = await project(session, selection);
      return { selection, fields, version: ranges.versionOf(selection.root) };
    } catch (error) {
      if (error.message !== 'source_version_changed' || attempt === 2) throw error;
      ranges.invalidate(selection.root);
    }
  }
  throw new Error('source_version_changed');
}

export async function startService({ source, directory, port = 0 }) {
  const store = await new Store(directory).initialize();
  const ranges = new RangeSource(source);
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true }));
      if (url.pathname === '/records' && request.method === 'GET') return response.end(JSON.stringify(await store.list()));
      if (url.pathname === '/projections' && request.method === 'GET') {
        return response.end(JSON.stringify(await store.listProjections()));
      }
      if (url.pathname.startsWith('/projections/') && request.method === 'GET') {
        const record = (await store.listProjections()).find(item => item.id === url.pathname.slice(13));
        if (!record) { response.writeHead(404); return response.end(JSON.stringify({ error: 'not_found' })); }
        return response.end(JSON.stringify(record));
      }
      if (url.pathname.startsWith('/objects/') && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/octet-stream');
        return response.end(await store.object(url.pathname.slice(9)));
      }
      if (url.pathname === '/intakes' && request.method === 'POST') {
        const payload = await readJson(request);
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const result = await acquire(source, payload.path);
        const parsed = inspect(result.bytes);
        const record = await store.accept(result.bytes, new URL(payload.path, source).href, parsed);
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }
      if (url.pathname === '/projections' && request.method === 'POST') {
        const payload = await readJson(request);
        const { selection, fields, version } = await runProjection(source, ranges, payload);
        const record = await store.acceptProjection({
          root: new URL(selection.root, source).href, version, fields });
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }
      response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) { response.statusCode = 422; response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, store, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.SOURCE_URL) throw new Error('SOURCE_URL_required');
  const service = await startService({ source: process.env.SOURCE_URL,
    directory: process.env.DATA_DIR ?? './data', port: Number(process.env.PORT ?? 4102) });
  console.log(JSON.stringify({ product: service.url }));
}
