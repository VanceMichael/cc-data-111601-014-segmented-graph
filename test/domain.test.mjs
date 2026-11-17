import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect } from '../src/reader.mjs';
import { bufferSession } from '../src/ranges.mjs';
import { validateSelection, project } from '../src/projection.mjs';
const primary=await readFile(new URL('../fixtures/primary.bin',import.meta.url));
const manifest=JSON.parse(await readFile(new URL('../fixtures/upstream.json',import.meta.url),'utf8'));
async function resource(path) {
  const item=manifest.resources[path];
  return item.file ? readFile(new URL(`../fixtures/${item.file}`,import.meta.url)) : Buffer.from(item.body);
}

function structPtr(offset,dataWords,pointerCount){
  return (BigInt(offset&0x3fffffff)<<2n)|(BigInt(dataWords)<<32n)|(BigInt(pointerCount)<<48n);
}
function listPtr(offset,elementSize,count){
  return 1n|(BigInt(offset&0x3fffffff)<<2n)|(BigInt(elementSize)<<32n)|(BigInt(count)<<35n);
}
function farPtr(double,padWord,segment){
  return 2n|(BigInt(double)<<2n)|(BigInt(padWord)<<3n)|(BigInt(segment)<<32n);
}
function message(...segments){
  const tableBytes=Math.ceil((4+4*segments.length)/8)*8;
  const buffer=Buffer.alloc(tableBytes+segments.reduce((sum,seg)=>sum+seg.length*8,0));
  buffer.writeUInt32LE(segments.length-1,0);
  segments.forEach((words,index)=>buffer.writeUInt32LE(words.length,4+4*index));
  let offset=tableBytes;
  for(const words of segments)for(const word of words){buffer.writeBigUInt64LE(word,offset);offset+=8;}
  return buffer;
}
async function select(bytes,fields,limits){
  const selection=validateSelection({root:'/local',fields,...limits});
  const session=bufferSession(bytes,limits??{maxWords:1024,maxRequests:64});
  return {result:await project(session,selection),session};
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

test('跨段投影：字段与引用带版本无关的段内位置，身份含段号',async()=>{
  const graph=await resource('/graph');
  const {result,session}=await select(graph,[
    {name:'deviceId',kind:'uint64',dataWord:0},
    {name:'shared',kind:'struct',pointerIndex:0}]);
  assert.equal(result.fields.deviceId.value,'42');
  assert.deepEqual(result.fields.deviceId.location,{segment:1,word:1});
  assert.equal(result.fields.shared.value,null);
  assert.deepEqual(result.fields.shared.pointer,{segment:1,word:2});
  assert.equal(result.fields.shared.location,null);
  assert.equal(session.counters.requests,5);
  assert.equal(session.counters.words,6);
});
test('畸形循环回指不被当作合法树，也不会无休止追逐',async()=>{
  const cycle=await resource('/cycle');
  await assert.rejects(()=>select(cycle,[{name:'loop',kind:'struct',pointerIndex:0}]),/capnp_object_overlap/);
  await assert.rejects(()=>select(cycle,[{name:'missing',kind:'uint64',dataWord:0}]),/field_bounds/);
});
test('double-far landing pad 解析到目标段内容',async()=>{
  const bytes=message(
    [farPtr(1,0,1)],
    [farPtr(0,3,2),structPtr(0,1,0)],
    [0n,0n,0n,999n]);
  const {result}=await select(bytes,[{name:'deviceId',kind:'uint64',dataWord:0}]);
  assert.equal(result.fields.deviceId.value,'999');
  assert.deepEqual(result.fields.deviceId.location,{segment:2,word:3});
});
test('inline composite 列表元素带各自段内位置',async()=>{
  const tag=(2n<<2n)|(1n<<32n)|(1n<<48n);
  const bytes=message([structPtr(0,0,1),listPtr(0,7,4),tag,11n,0n,22n,0n]);
  const {result}=await select(bytes,[{name:'items',kind:'list',pointerIndex:0}]);
  const value=result.fields.items.value;
  assert.equal(value.elementSize,7);assert.equal(value.count,2);
  assert.deepEqual(value.elements[0],{dataWords:['11'],pointerCount:1,location:{segment:0,word:3}});
  assert.deepEqual(value.elements[1],{dataWords:['22'],pointerCount:1,location:{segment:0,word:5}});
});
test('原始类型列表与指针列表元素',async()=>{
  const bytes=message([structPtr(0,0,2),listPtr(1,5,2),listPtr(2,6,2),7n,8n,0n,structPtr(0,1,0),42n]);
  const {result}=await select(bytes,[
    {name:'numbers',kind:'list',pointerIndex:0},
    {name:'refs',kind:'list',pointerIndex:1}]);
  assert.deepEqual(result.fields.numbers.value.elements,['7','8']);
  const refs=result.fields.refs.value.elements;
  assert.deepEqual(refs[0],{kind:'null',pointer:{segment:0,word:5}});
  assert.deepEqual(refs[1],{kind:'struct',location:{segment:0,word:7},dataWords:1,pointerCount:0});
});
test('struct 字段返回引用对象的数据词与位置',async()=>{
  const bytes=message([structPtr(0,0,1),structPtr(0,1,1),123n,0n]);
  const {result}=await select(bytes,[{name:'shared',kind:'struct',pointerIndex:0}]);
  assert.deepEqual(result.fields.shared.value,{dataWords:['123'],pointerCount:1,location:{segment:0,word:2}});
  assert.deepEqual(result.fields.shared.location,{segment:0,word:2});
});
test('UInt64 读数保留完整精度',async()=>{
  const bytes=message([structPtr(0,1,0),0xffffffffffffffffn]);
  const {result}=await select(bytes,[{name:'deviceId',kind:'uint64',dataWord:0}]);
  assert.equal(result.fields.deviceId.value,'18446744073709551615');
});
test('越界指针与坏指针不变成空对象',async()=>{
  const outOfBounds=message([structPtr(0,0,1),structPtr(5,1,0)]);
  await assert.rejects(()=>select(outOfBounds,[{name:'x',kind:'struct',pointerIndex:0}]),/capnp_bounds/);
  const farChain=message([farPtr(0,0,1)],[farPtr(0,0,2)],[structPtr(0,1,0),1n]);
  await assert.rejects(()=>select(farChain,[{name:'x',kind:'uint64',dataWord:0}]),/capnp_far_chain/);
  const capability=message([structPtr(0,0,1),3n]);
  await assert.rejects(()=>select(capability,[{name:'x',kind:'struct',pointerIndex:0}]),/capnp_pointer_kind/);
});
test('别名同号位置不被宣布为合法对象',async()=>{
  const alias=message([structPtr(0,0,2),structPtr(1,1,0),structPtr(0,1,0),5n]);
  await assert.rejects(()=>select(alias,[
    {name:'a',kind:'struct',pointerIndex:0},
    {name:'b',kind:'struct',pointerIndex:1}]),/capnp_object_overlap/);
});
test('资源边界：词数与请求数预算可观察',async()=>{
  const graph=await resource('/graph');
  await assert.rejects(()=>select(graph,[{name:'deviceId',kind:'uint64',dataWord:0}],{maxWords:3,maxRequests:64}),
    /word_budget_exceeded/);
  await assert.rejects(()=>select(graph,[{name:'deviceId',kind:'uint64',dataWord:0}],{maxWords:128,maxRequests:2}),
    /request_budget_exceeded/);
});
test('空根与字段越界被拒绝而非空值',async()=>{
  await assert.rejects(()=>select(message([0n]),[{name:'x',kind:'uint64',dataWord:0}]),/root_not_struct/);
  const graph=await resource('/graph');
  await assert.rejects(()=>select(graph,[{name:'x',kind:'uint64',dataWord:9}]),/field_bounds/);
  await assert.rejects(()=>select(graph,[{name:'x',kind:'struct',pointerIndex:7}]),/field_bounds/);
});
test('选择校验拒绝未知字段种类与重复字段',()=>{
  assert.throws(()=>validateSelection({root:'/x',fields:[{name:'a',kind:'wat',dataWord:0}]}),/selection_field_kind/);
  assert.throws(()=>validateSelection({root:'/x',fields:[
    {name:'a',kind:'uint64',dataWord:0},{name:'a',kind:'uint64',dataWord:1}]}),/selection_field_duplicate/);
  assert.throws(()=>validateSelection({root:'/x',fields:[]}),/selection_fields_required/);
});
