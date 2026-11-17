import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.pending = Promise.resolve();
  }
  async initialize() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    for (const [file, fallback] of [['index.json', []], ['projections.json', []]]) {
      try { await readFile(join(this.directory, file), 'utf8'); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await this.saveJson(file, fallback);
      }
    }
    return this;
  }
  async saveJson(file, value) {
    const temporary = join(this.directory, `${file}-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(value));
    await rename(temporary, join(this.directory, file));
  }
  async saveIndex(records) {
    await this.saveJson('index.json', records);
  }
  async list() {
    return JSON.parse(await readFile(join(this.directory, 'index.json'), 'utf8'));
  }
  async listProjections() {
    return JSON.parse(await readFile(join(this.directory, 'projections.json'), 'utf8'));
  }
  async accept(bytes, source, parsed) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const operation = this.pending.then(async () => {
      const records = await this.list();
      const existing = records.find(record => record.digest === digest && record.source === source);
      if (existing) return existing;
      await writeFile(join(this.directory, 'objects', digest), bytes);
      const record = { id: randomUUID(), digest, source, bytes: bytes.length, parsed };
      records.push(record);
      await this.saveIndex(records);
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  // 投影记录按 (root, version) 归并：同一设备同一文件版本的多次补领合并到同一记录，
  // 只登记已实际领取的字段；源文件更换后版本不同，另立记录，不沿用旧解释。
  async acceptProjection({ root, version, fields }) {
    const operation = this.pending.then(async () => {
      const records = await this.listProjections();
      const existing = records.find(record => record.root === root && record.version === version);
      if (existing) {
        existing.fields = { ...existing.fields, ...fields };
        await this.saveJson('projections.json', records);
        return existing;
      }
      const record = { id: randomUUID(), root, version, fields };
      records.push(record);
      await this.saveJson('projections.json', records);
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async object(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_digest');
    return readFile(join(this.directory, 'objects', digest));
  }
}
