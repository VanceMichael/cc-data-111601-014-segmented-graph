export function inspect(bytes) {
  if (bytes.length < 8) throw new Error('capnp_header_short');
  const count = bytes.readUInt32LE(0) + 1;
  if (count !== 1) throw new Error('single_segment_reader');
  const words = bytes.readUInt32LE(4);
  if (words < 1 || bytes.length !== 8 + words * 8) throw new Error('capnp_segment_size');
  const pointer = bytes.readBigUInt64LE(8);
  if ((pointer & 3n) !== 0n) throw new Error('direct_struct_reader');
  const rawOffset = Number((pointer >> 2n) & 0x3fffffffn);
  const relative = rawOffset & 0x20000000 ? rawOffset - 0x40000000 : rawOffset;
  const dataWords = Number((pointer >> 32n) & 0xffffn);
  const pointers = Number(pointer >> 48n);
  const start = 16 + relative * 8;
  const end = start + (dataWords + pointers) * 8;
  if (start < 8 || end > bytes.length) throw new Error('capnp_struct_bounds');
  return { kind: 'capnp-direct-struct', segments: 1, words, dataWords, pointers,
    location: { segment: 0, word: (start - 8) / 8 }, data: bytes.subarray(start, start + dataWords * 8).toString('hex') };
}
