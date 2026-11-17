# segmented-graph

分段图记录的远端指针定向领取相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

已有单段直接结构查看、范围 HTTP 原件领取，以及分段图的选择性采集（定向领取）。

`src/reader.mjs` 提供现有单件读取契约；`src/capnp.mjs` 按 Cap'n Proto 未打包 framing 解析多段消息，支持 struct/list、single-far/double-far landing pad、inline composite list 与 null pointer；`src/projection.mjs` 校验选择并驱动遍历；`src/ranges.mjs` 按 (来源地址, 文件版本) 缓存已核实字节区间并执行 If-Match/If-None-Match 版本钉住；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转；`src/store.mjs` 保存原件摘要、解释结果和投影记录。`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品、接收单件原件、按选择描述定向领取分段图字段、分别补领同一设备字段、模拟来源侧更换文件后重新领取、拒绝畸形回指，然后关闭服务并清理临时目录。它展示当前产品能力，不模拟尚不存在的能力。演示没有固定等待、外网访问或人工操作，通常数秒结束。扩展产品后可按实际能力更新演示路径；不要以打印预先保存的结果替代运行。

分开运行时，先 `npm run source`，来源监听 127.0.0.1:4101；在另一终端设置 SOURCE_URL=http://127.0.0.1:4101 后运行 `npm start`，产品默认 4102。DATA_DIR 可设置资料目录，PORT 可分别覆盖监听端口。构建产物位于 dist，当前脚本仅使用 Node 内置模块。

## 已有接口

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。
- GET /records：持久接收目录；同 source URL、同摘要重领返回原 id。
- GET /objects/{digest}：读取已保存的原始字节。
- POST /projections：分段图定向领取，两种形式：
  - {"path":"/projection","fields":["deviceId",…]}：先取来源的选择描述（root、字段、maxWords、maxRequests），fields 可再限定子集；
  - {"root":"/graph","fields":[{"name":"deviceId","kind":"uint64","dataWord":0}],"maxWords":…,"maxRequests":…}：内联选择。
- GET /projections：持久投影目录；同 root、同版本的多份投影合入同一记录，只登记已实际领取的字段。
- GET /projections/{id}：读取单条投影记录。

前四项是兼容接口，后续扩展可以新增业务入口，但不能把 GET 请求变为写操作。收件记录当前只包含单件 raw 对象，不代表关联资料已完整。

## 定向领取语义

- 遍历身份为 (object version, segment, word)：字段结果带 version（来源 ETag）与段内位置 {segment, word}，不同段里的同号位置不是同一件资料。
- 根对象只经单一 bytes 范围请求领取，不整包下载；同一来源的多次投影复用已核实区间，每次会话首读以 If-None-Match 复核版本，304 复用字节，源文件更换后作废旧区间整轮重取，不沿用旧的指针解释。
- maxWords 与 maxRequests 是选择声明的可观察资源边界：词数按遍历读取计（含缓存命中），请求数按对来源的真实请求计（含 304 复核）。
- 同一遍历内指针字与对象内容字不得重叠：别名或环（如 /cycle）不被宣布为合法对象，畸形回指不会无休止追逐；边界坏指针报错，不变成空对象；未领取的字段不出现在结果里，也不冒充空值。
- UInt64 读数以十进制字符串返回，保留完整精度。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖现有读取器、畸形输入、真实 HTTP 领取、原件一致性、持久重开、同源边界和范围响应；领域读取行为在 test/domain.test.mjs，定向领取、区间复用、版本失效与资源边界在 test/integration.test.mjs。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t segmented-graph:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
