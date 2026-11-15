import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect } from '../src/reader.mjs';
const primary=await readFile(new URL('../fixtures/primary.bin',import.meta.url));
const manifest=JSON.parse(await readFile(new URL('../fixtures/upstream.json',import.meta.url),'utf8'));
async function resource(path) {
  const item=manifest.resources[path];
  return item.file ? readFile(new URL(`../fixtures/${item.file}`,import.meta.url)) : Buffer.from(item.body);
}

test('单段结构直接数据具有准确位置',()=>{
  const result=inspect(primary);assert.equal(result.dataWords,1);assert.equal(result.location.word,1);
  assert.equal(result.data,'2a00000000000000');
});
test('分段来源是真实 far pointer 而非 JSON 关系替身',async()=>{
  const graph=await resource('/graph');assert.equal(graph.readUInt32LE(0),1);
  assert.equal(Number(graph.readBigUInt64LE(16)&3n),2);assert.throws(()=>inspect(graph));
});
test('越界结构不当作 null 指针',()=>{
  const changed=Buffer.from(primary);changed.writeBigUInt64LE(0xffffn<<32n,8);assert.throws(()=>inspect(changed));
  assert.throws(()=>inspect(primary.subarray(0,10)));
});
