// 按 root URL + ETag 持有各版本的字节清单，并记录每个 root 路径当前已确认的版本。
// 同一 root 路径再次选择时强制 If-Match：文件更换会暴露为版本冲突，
// 而不会让新版本字节沿用旧清单的指针解释。
export class InventoryRegistry {
  constructor() {
    this.byVersion = new Map();
    this.versionByPath = new Map();
  }

  get(key) {
    return this.byVersion.get(key);
  }

  set(key, inventory) {
    this.byVersion.set(key, inventory);
  }

  noteVersion(path, etag) {
    this.versionByPath.set(path, etag);
  }

  versionFor(path) {
    return this.versionByPath.get(path) ?? null;
  }

  // 来源更换并确认新版本后，丢弃该路径的旧版本记录（旧清单对象自然不再被引用）。
  resetPath(path) {
    const etag = this.versionByPath.get(path);
    if (etag) this.byVersion.delete(`${path}|${etag}`);
    this.versionByPath.delete(path);
  }
}
