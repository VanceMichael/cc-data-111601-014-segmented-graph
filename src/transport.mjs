function targetUrl(base, path) {
  const origin = new URL(base);
  const target = new URL(path, origin);
  if (target.origin !== origin.origin) throw new Error('outside_source');
  return target;
}

async function readBody(response, limit) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('source_too_large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function acquire(base, path, headers = {}) {
  const target = targetUrl(base, path);
  const response = await fetch(target, { headers, redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`source_status_${response.status}`);
  return { bytes: await readBody(response, 8 * 1024 * 1024), headers: Object.fromEntries(response.headers), status: response.status };
}

export async function acquireRange(base, path, start, end, headers = {}) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) throw new Error('invalid_range_request');
  const target = targetUrl(base, path);
  const response = await fetch(target, {
    headers: { ...headers, range: `bytes=${start}-${end - 1}` },
    redirect: 'error', signal: AbortSignal.timeout(5000) });
  return { bytes: await readBody(response, 8 * 1024 * 1024), headers: Object.fromEntries(response.headers), status: response.status };
}
