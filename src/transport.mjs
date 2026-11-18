export async function acquire(base, path, headers = {}) {
  const origin = new URL(base);
  const target = new URL(path, origin);
  if (target.origin !== origin.origin) throw new Error('outside_source');
  const response = await fetch(target, { headers, redirect: 'error', signal: AbortSignal.timeout(5000) });
  // 条件请求失配表示调用方手里的版本已过期，单独上报而不是泛化成普通状态错误。
  if (response.status === 412) throw new Error('source_version_changed');
  if (!response.ok) throw new Error(`source_status_${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('source_too_large');
    chunks.push(Buffer.from(chunk));
  }
  return { bytes: Buffer.concat(chunks), headers: Object.fromEntries(response.headers), status: response.status };
}

function quotedEtag(header) {
  if (typeof header !== 'string' || !header.startsWith('"')) return header;
  return header;
}

// 定向领取一个字节区间。来源可能诚实回答 206，也可能忽略 Range 回整包（200），
// 两种情况都按实际收到的字节登记；条件请求失配（412）必须显式上报版本变化。
export async function acquireRange(base, path, { begin, end, etag } = {}) {
  const origin = new URL(base);
  const target = new URL(path, origin);
  if (target.origin !== origin.origin) throw new Error('outside_source');
  if (!Number.isInteger(begin) || !Number.isInteger(end) || begin < 0 || end < begin) {
    throw new Error('invalid_range_span');
  }
  const headers = { Range: `bytes=${begin}-${end}` };
  if (etag) headers['If-Match'] = etag;
  const response = await fetch(target, { headers, redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (response.status === 412) throw new Error('source_version_changed');
  if (response.status !== 206 && response.status !== 200) {
    throw new Error(`source_status_${response.status}`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('source_too_large');
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  const responseEtag = quotedEtag(response.headers.get('etag'));
  if (etag && responseEtag && responseEtag !== etag) throw new Error('source_version_changed');
  if (response.status === 206) {
    const contentRange = response.headers.get('content-range');
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? '');
    if (!match || Number(match[1]) !== begin || Number(match[2]) !== end || bytes.length !== end - begin + 1) {
      throw new Error('source_range_mismatch');
    }
    return { begin, end, bytes, etag: responseEtag ?? etag, full: false,
      resourceLength: Number(match[3]) };
  }
  if (bytes.length < end + 1) throw new Error('source_range_mismatch');
  return { begin: 0, end: bytes.length - 1, bytes, etag: responseEtag ?? etag, full: true,
    resourceLength: bytes.length };
}
