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
    try { await this.list(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveIndex([]);
    }
    try { await this.listProjections(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveProjectionIndex([]);
    }
    return this;
  }
  async saveIndex(records) {
    const temporary = join(this.directory, `index-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(records));
    await rename(temporary, join(this.directory, 'index.json'));
  }
  async saveProjectionIndex(records) {
    const temporary = join(this.directory, `projections-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(records));
    await rename(temporary, join(this.directory, 'projections.json'));
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
  async object(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_digest');
    return readFile(join(this.directory, 'objects', digest));
  }
  async acceptProjection(record) {
    const operation = this.pending.then(async () => {
      const records = await this.listProjections();
      const existing = records.find(item => item.key === record.key && item.version === record.version);
      if (existing) return existing;
      records.push(record);
      await this.saveProjectionIndex(records);
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async projection(id) {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new Error('invalid_projection_id');
    const records = await this.listProjections();
    return records.find(item => item.id === id) ?? null;
  }
  async appendProjectionFields(id, fields) {
    const operation = this.pending.then(async () => {
      const records = await this.listProjections();
      const record = records.find(item => item.id === id);
      if (!record) throw new Error('projection_not_found');
      record.fields = { ...record.fields, ...fields };
      await this.saveProjectionIndex(records);
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
