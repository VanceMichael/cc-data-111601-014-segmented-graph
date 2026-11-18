# segmented-graph

分段图记录的远端指针定向领取相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

支持单段直接结构查看、范围 HTTP 原件领取，以及分段 Cap’n Proto 图的定向字段领取（selection）。分段读取解析 single-far/double-far 落点、跨段引用、struct/list 与 inline composite 元素，只按需发 Range 请求而不整包下载；每个解析结果都带 `{version, segment, word}` 身份，不同段的同号 word 不会被当成同一位置。

`src/reader.mjs` 在保留单件 `inspect` 契约的同时提供惰性分段解释器；`src/inventory.mjs` 是按 root 路径 + ETag 登记的已核实字节清单（区间合并、预算计量、版本失效）；`src/selection.mjs` 编排描述符校验、字段解释与溯源；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转，支持 Range 与条件请求；`src/store.mjs` 保存原件摘要、解释结果与投影记录。`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品、领取一件资料、读取已保存结果，然后关闭服务并清理临时目录。它展示当前产品能力，不模拟尚不存在的能力。演示没有固定等待、外网访问或人工操作，通常数秒结束。扩展产品后可按实际能力更新演示路径；不要以打印预先保存的结果替代运行。

直接 `npm start` 即可启动产品，默认自动在临时回环端口创建本地合成来源，产品默认监听 127.0.0.1:4102。退出产品时同步关闭自带来源。需要联调独立来源时先运行 `npm run source`，再设置 SOURCE_URL=http://127.0.0.1:4101 运行 `npm start`；显式来源不会由产品关闭。DATA_DIR 可设置资料目录，PORT 可覆盖产品监听端口。构建产物位于 dist，启动、测试与演示均不需要外部服务或下载。

## 已有接口

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。
- GET /records：持久接收目录；同 source URL、同摘要重领返回原 id。
- GET /objects/{digest}：读取已保存的原始字节。
- POST /selections：分段图定向领取。JSON 为 {"path":"/projection","fields":["deviceId"]}（fields 可省略表示描述符全部字段），或同源内联 {"descriptor":{...},"fields":[...]}。按 maxWords/maxRequests 计量，只发 Range 请求；同版本投影复用已核实字节。
- GET /projections/{id}：读取一次选择的持久化投影（含 root、version、rootLocation、各字段 status 与位置）。
- GET /projections/{id}/fields/{name}：读取单字段溯源；字段尚未领取时返回 404 field_not_selected，不冒充空值。

前四项是兼容接口，后续扩展可以新增业务入口，但不能把 GET 请求变为写操作。收件记录当前只包含单件 raw 对象，不代表关联资料已完整。选择接口在来源版本变化（If-Match 失配）时返回 409 source_version_changed，旧字节清单作废；畸形回指、越界指针和预算越界返回 422 并带明确错误码。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖现有读取器、畸形输入、真实 HTTP 领取、原件一致性、持久重开、同源边界和范围响应；分段 far/double-far、列表元素、环与深度保护、DAG 别名在 test/segmented.test.mjs，区间合并与预算在 test/inventory.test.mjs，定向领取、版本失效、未领取字段语义和持久投影在 test/selection.test.mjs。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t segmented-graph:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
