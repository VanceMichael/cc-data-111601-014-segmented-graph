# 来源约定

## 产品交换范围

按 Cap’n Proto 未打包 framing：segment count minus one、各 segment word count，段表补齐 64 bit。支持 struct/list、single-far/double-far landing pad、inline composite list、null pointer；不要求能力指针或 packed 编码。/projection 给出根对象及所需 dataWord/pointerIndex，读数保留 UInt64 精度。/graph 为两个段的 far pointer 样例，/cycle 是畸形循环指针，不能当合法树接受；同一来源允许多个投影请求复用已确认区间，并不把别名或环宣布成合法对象语义。遍历身份必须含 object version、segment 与 word。范围 HTTP 支持 ETag/If-Match；maxWords 与 maxRequests 在 selection 上定义可观察的资源边界，不要求指定缓存算法。边界坏指针不得变成空对象。

## 当前来源路由

- `/primary`：application/octet-stream
- `/graph`：application/octet-stream
- `/cycle`：application/octet-stream
- `/projection`：application/json

`/catalog` 提供入口及业务选择。资源字节支持 GET/HEAD、单一 bytes 范围、ETag 和 If-Match，响应不会跨来源重定向。`/_phase` 为联调控制路径，不是产品数据来源，不应由产品自行切换阶段。

## 依据和范围说明

- https://capnproto.org/encoding.html

以上是格式或业务词汇的公开依据；本项目明确限定的交换子集以本文及实际资源为准，未要求完整标准实现。元数据和未支持声明应保留可定位的来源，不把未知转换成已确认的空结果。HTTP 来源状态、原件结构和产品接收完整性是不同层次；现有通用收件接口成功只表示该单件已保存。
