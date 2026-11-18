import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store } from './store.mjs';
import { acquire } from './transport.mjs';
import { inspect } from './reader.mjs';
import { SelectionContext, validateDescriptor } from './selection.mjs';
import { InventoryRegistry } from './inventory-registry.mjs';
import { startProvider } from './provider.mjs';

async function readJson(request, limit = 65536) {
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

export async function startService({ source, directory, port = 0 }) {
  const store = await new Store(directory).initialize();
  // 键为 root URL + ETag：同一版本的多份投影复用已核实字节，版本更换后另起清单。
  const inventories = new InventoryRegistry();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true }));
      if (url.pathname === '/records' && request.method === 'GET') return response.end(JSON.stringify(await store.list()));
      if (url.pathname.startsWith('/objects/') && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/octet-stream');
        return response.end(await store.object(url.pathname.slice(9)));
      }
      if (url.pathname === '/intakes' && request.method === 'POST') {
        const payload = await readJson(request, 16384);
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const result = await acquire(source, payload.path);
        const parsed = inspect(result.bytes);
        const record = await store.accept(result.bytes, new URL(payload.path, source).href, parsed);
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }
      if (url.pathname === '/selections' && request.method === 'POST') {
        const payload = await readJson(request);
        let descriptor;
        let descriptorPath;
        if (payload.descriptor && typeof payload.descriptor === 'object') {
          // 内联描述符只允许指向配置来源的同源根，不借描述符跳去外部地址。
          descriptor = payload.descriptor;
          descriptorPath = null;
          const rootUrl = new URL(descriptor.root, source);
          if (rootUrl.origin !== new URL(source).origin) throw new Error('outside_source');
        } else {
          if (typeof payload.path !== 'string') throw new Error('path_required');
          descriptorPath = payload.path;
          const descriptorResponse = await acquire(source, payload.path);
          descriptor = JSON.parse(descriptorResponse.bytes.toString());
        }
        validateDescriptor(descriptor);
        const context = new SelectionContext({ base: source, descriptor, inventories });
        const wanted = payload.fields ?? null;
        const result = await context.select(wanted);
        const key = `${new URL(descriptor.root, source).href}|${descriptorPath ?? 'inline'}|${JSON.stringify(wanted ?? [])}`;
        const id = randomUUID();
        const record = await store.acceptProjection({
          id, key, descriptorPath, source: descriptorPath ? new URL(descriptorPath, source).href : null,
          root: result.root, version: result.version, rootLocation: result.rootLocation,
          descriptor: result.descriptor, budgets: result.budgets, fields: result.fields,
          requested: wanted ?? descriptor.fields.map(field => field.name),
        });
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }
      const projectionMatch = /^\/projections\/([A-Za-z0-9-]{8,64})$/.exec(url.pathname);
      if (projectionMatch && request.method === 'GET') {
        const record = await store.projection(projectionMatch[1]);
        if (!record) { response.writeHead(404); return response.end(JSON.stringify({ error: 'not_found' })); }
        return response.end(JSON.stringify(record));
      }
      const fieldMatch = /^\/projections\/([A-Za-z0-9-]{8,64})\/fields\/([A-Za-z0-9_.-]+)$/.exec(url.pathname);
      if (fieldMatch && request.method === 'GET') {
        const record = await store.projection(fieldMatch[1]);
        if (!record) { response.writeHead(404); return response.end(JSON.stringify({ error: 'not_found' })); }
        const field = record.fields[fieldMatch[2]];
        if (!field) {
          // 尚未领取的字段不冒充空值：明确告诉调用方它还不在这份投影里。
          response.writeHead(404);
          return response.end(JSON.stringify({ error: 'field_not_selected', name: fieldMatch[2] }));
        }
        return response.end(JSON.stringify(field));
      }
      if (fieldMatch || projectionMatch) { response.writeHead(405); return response.end(JSON.stringify({ error: 'method_not_allowed' })); }
      response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) {
      if (error.message === 'source_version_changed') {
        // 丢弃该 root 路径记忆的旧版本，下一次选择以新文件重新建立版本与清单。
        if (typeof inventories.resetPath === 'function') {
          const rootHint = error.rootPath;
          if (rootHint) inventories.resetPath(rootHint);
        }
        response.statusCode = 409;
      } else {
        response.statusCode = 422;
      }
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, store, inventories, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const provider = process.env.SOURCE_URL ? null : await startProvider();
  const source = process.env.SOURCE_URL ?? provider.url;
  let service;
  try {
    service = await startService({ source, directory: process.env.DATA_DIR ?? './data',
      port: Number(process.env.PORT ?? 4102) });
  } catch (error) {
    if (provider) await provider.close();
    throw error;
  }
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await service.close();
    if (provider) await provider.close();
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  console.log(JSON.stringify({ product: service.url, source }));
}
