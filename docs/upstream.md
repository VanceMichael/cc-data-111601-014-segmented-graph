# 来源约定

## 产品交换范围

按 Cap’n Proto 未打包 framing：segment count minus one、各 segment word count，段表补齐 64 bit。支持 struct/list、single-far/double-far landing pad、inline composite list、null pointer；不要求能力指针或 packed 编码。/projection 给出根对象及所需 dataWord/pointerIndex，读数保留 UInt64 精度。/graph 为两个段的 far pointer 样例，/cycle 是畸形循环指针，不能当合法树接受；同一来源允许多个投影请求复用已确认区间，并不把别名或环宣布成合法对象语义。遍历身份必须含 object version、segment 与 word。范围 HTTP 支持 ETag/If-Match；maxWords 与 maxRequests 在 selection 上定义可观察的资源边界，不要求指定缓存算法。边界坏指针不得变成空对象。

## 当前来源路由

- `/primary`：application/octet-stream
- `/graph`：application/octet-stream
- `/cycle`：application/octet-stream
- `/projection`：application/json

`/catalog` 提供入口及业务选择。资源字节支持 GET/HEAD、单一 bytes 范围、ETag 和 If-Match，响应不会跨来源重定向。`/_phase` 为联调控制路径，不是产品数据来源，不应由产品自行切换阶段。

### far 指针字段约定（以实际资源为准）

本子集的 far 指针按来源资源的实际编码解释，位排布与标准文档略有差异：

- bit 0–1：far 标记（资源中读到 2 或 3 都按 far 处理）。
- bit 2–31：landing pad 的 word 偏移（30 位）。
- bit 32–62：landing pad 所在 segment 编号。
- bit 63：double-far 标记；为 1 时 landing pad 占两个 word，第二个 word 为 single-far（B=0）或 null（B=1，内容紧随其后）。

不同 segment 中的同号 word 是不同位置；任何解析结果的身份都带 `{version, segment, word}`，version 来自该资源当前 ETag。

## 定向领取（selection）

`POST /selections` 接受 `{"path":"/projection","fields":[...]}` 拉取来源描述符，或同源内联 `{"descriptor":{...},"fields":[...]}`（descriptor.root 必须与配置来源同源，否则 `outside_source`）。产品只按需发 Range 请求，不整包下载：先以 `bytes=0-0` 确认版本与资源长度，再按 framing、far 落点和字段位置逐段领取，相邻缺口合并、已核实区间在同版本投影间复用。每个 selection 独立计量 `maxRequests` 与 `maxWords`，越界返回 `selection_request_budget` / `selection_word_budget`。

- 同一 root 路径确认过版本后，后续请求带 `If-Match`；来源换文件使 ETag 变化时返回 409 `source_version_changed`，旧清单作废，不沿用旧指针解释。
- 字段结果区分 `present` 与显式 `null`（读到零指针才算空）；尚未领取的字段不在投影中，读取返回 404 `field_not_selected`，绝不冒充空值。
- 畸形回指命中 `capnp_pointer_cycle`，超长 far 链命中 `capnp_pointer_depth`，越界命中 `capnp_bounds` / `capnp_bad_segment`，均拒绝为 422，不降级为空对象。
- `GET /projections/{id}` 读取持久化投影，`GET /projections/{id}/fields/{name}` 读取单字段（含 version、segment、word 溯源）。

## 依据和范围说明

- https://capnproto.org/encoding.html

以上是格式或业务词汇的公开依据；本项目明确限定的交换子集以本文及实际资源为准，未要求完整标准实现。元数据和未支持声明应保留可定位的来源，不把未知转换成已确认的空结果。HTTP 来源状态、原件结构和产品接收完整性是不同层次；现有通用收件接口成功只表示该单件已保存。
