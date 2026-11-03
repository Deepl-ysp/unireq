# unireq

一个 TypeScript 网络请求库，**零运行时依赖**（只用 Node 内置模块），Node >= 18。它围绕 `request(input)` 提供统一的请求/响应模型、错误体系、超时、取消、中间件、query 序列化、重试和可插拔传输层。

内置 `http://` / `https://` 传输，以及 Tauri 2.x 的 `ipc://` 传输（Windows 下走 `http://ipc.localhost`）。

> 本项目位于 VarJson 仓库根目录的 `unireq/`，是一个**独立项目**，不参与根目录的 npm workspace；`varjson` 以**可选 peer 依赖**的方式使用它。

## 发布

发布为**手工流程**（不使用 NPM_TOKEN）：CI 只负责 tag 触发的构建与 GitHub Release。
完整步骤见 [PUBLISHING.md](./PUBLISHING.md)。

## 安装与运行

```bash
cd unireq
npm install          # 只安装开发依赖 typescript / @types/node
npm run typecheck    # strict 类型检查（src + test）
npm test             # 编译测试并运行 node:test
npm run build        # 产出 dist/（JS + d.ts）
```

## 快速开始

```ts
import { request } from 'unireq'

// 1. 直接传 URL 字符串
const users = await request('https://api.example.com/users')

// 2. 传选项对象
const created = await request({
  url: 'https://api.example.com/users',
  method: 'POST',
  headers: { authorization: `Bearer ${token}` },
  query: {
    tag: ['a', 'b'],            // 数组 -> ?tag=a&tag=b
    page: 1,
    skip: undefined,            // null / undefined 会被忽略
    since: new Date('2026-01-01T00:00:00Z'), // Date -> ISO 字符串
  },
  body: { name: 'Ada' },        // 普通对象自动 JSON 序列化并补 content-type
  timeout: 5000,
  responseType: 'json',
})

console.log(created.status)     // 200
console.log(created.headers)    // 全部小写
console.log(created.data)       // 解析后的 JSON
console.log(created.raw.body)   // 原始字节（Uint8Array）
```

`body` 支持三种形态：字符串、`Uint8Array`（含 `Buffer`）、其他可 JSON 序列化的值。

### 响应模型

所有传输最终都归一为：

```ts
interface ClientResponse<T> {
  status: number
  headers: Record<string, string>
  data: T
  raw: { status: number; headers: Record<string, string>; body: Uint8Array }
}
```

`responseType` 决定 `data`：

- `auto`（默认）：根据 `content-type` 判断——JSON 解析成对象；`text/*`、XML 等解析成字符串；其余保留字节。
- `json` / `text` / `buffer` / `arraybuffer`：强制指定。`buffer` 返回 `Uint8Array`（Node 下即 `Buffer`），`arraybuffer` 返回 `ArrayBuffer`。

空 JSON body 解析为 `null`；JSON 解析失败抛 `ParseError`。

### 超时与取消

```ts
const controller = new AbortController()
const pending = request({
  url: 'https://api.example.com/slow',
  timeout: 3000,
  signal: controller.signal,
})

controller.abort() // -> CancelError (code: ECANCEL)
```

超时是**每次尝试**独立计时：重试时会重新开始计时。超时抛 `TimeoutError`（`ETIMEOUT`）。

### 默认客户端与中间件

```ts
import { createClient } from 'unireq'

const client = createClient({
  baseUrl: 'https://api.example.com',
  headers: { 'x-app': 'demo' },
  timeout: 5000,
  retry: { count: 2, delayMs: 200, factor: 2 },
})

client.use(async (req, next) => {
  req.headers.authorization = `Bearer ${token}`
  const res = await next()          // 洋葱模型：请求前 / 响应后都能处理
  res.headers['x-request-id'] = 'seen'
  return res
})

const res = await client.request({ url: '/users', method: 'GET' })
await client.close()                // 释放传输层资源
```

中间件按注册顺序从外到内执行：`a:before -> b:before -> b:after -> a:after`。

### 安全策略（policy）

策略统一收敛为 allow/deny 一套语义，并作为**第一个中间件**运行，后续中间件无法绕过：

```ts
import { createClient, PolicyError } from 'unireq'

const client = createClient({
  policy: {
    mode: 'deny',                                         // 默认 'allow'
    allow: ['api.example.com', 'https://cdn.example.com/assets'],
    deny: ['tracker.example.com'],
    denySchemes: ['file', 'javascript'],
    allowSameOrigin: true,
  },
})
```

判定顺序：

1. `denySchemes`：scheme 命中即拒绝（`denied-scheme`），带不带尾部冒号都行。
2. `deny`：命中即拒绝（`denied`），优先于白名单和同源。
3. `allowSameOrigin`：浏览器里目标 origin 等于 `location.origin` 时放行；它与 `allow` 是**或**关系。Node 没有 `location`，此条不生效。
4. `allow`：命中即放行。
5. `mode === 'deny'` 且以上都没命中 → 拒绝（`not-allowlisted`）。默认 `mode: 'allow'` 时放行，保持库的通用性。

规则写法：

- `'*'`：全部；
- `'scheme://host'`：匹配该 origin；带路径时按路径前缀匹配；
- `'host'` / `'host:port'`：按 host / hostname 匹配；
- `RegExp`：对完整 URL 执行 `test`，会自动重置 `lastIndex`。

调用方可以透传上下文，`PolicyError` 原样保留，方便上层拼报错文案：

```ts
try {
  await client.request({
    url: 'https://evil.example/x',
    context: { chain: ['root.vjson', 'child.vjson'] },
  })
} catch (error) {
  if (error instanceof PolicyError) {
    error.code     // 'EPOLICY'
    error.reason   // 'denied' | 'denied-scheme' | 'not-allowlisted'
    error.origin   // 'https://evil.example'
    error.context  // 原样透传的 { chain: [...] }
  }
}
```

### fetchOptions（纯技术参数）

`fetchOptions` 只承载 `fetch` 的技术参数（`mode` / `credentials` / `redirect` / `referrerPolicy`），**不是 CORS 策略，也不是 allow/deny 的落点**；所有策略判定都走上面的 `policy`。

```ts
const client = createClient({
  fetchOptions: { credentials: 'omit', redirect: 'follow', mode: 'cors' },
})

await client.request({
  url: '/users',
  fetchOptions: { credentials: 'include' }, // 按字段覆盖默认值
})
```

不使用 `fetch` 的传输层（例如 Tauri IPC 之外的协议适配器）可以忽略这些字段。

### 重试

```ts
await request({
  url: 'https://api.example.com/flaky',
  retry: 2, // 等价于 { count: 2 }
})
```

- `count` 表示首次失败后的重试次数。
- 默认只重试幂等方法（`GET/HEAD/OPTIONS/PUT/DELETE`）。
- 默认重试条件：超时、网络错误、HTTP 5xx。
- 退避为 `delayMs * factor^attempt`，默认 `100ms` 起步、`factor = 2`。
- 需要重试 POST 或自定义条件时：

```ts
retry: {
  count: 3,
  delayMs: 100,
  methods: ['POST'],
  retryOn: (error) => error.code === 'ETIMEOUT',
}
```

重试等待期间取消，同样会抛 `CancelError`。

## 错误体系

`RequestError` 是基类，所有错误都带 `code`、`url`、`method`，部分错误带 `response`（原始响应上下文）。

| 类 | code | 场景 |
| --- | --- | --- |
| `InvalidRequestError` | `EINVALID` | 非法 URL、缺少 URL、无匹配传输层 |
| `CancelError` | `ECANCEL` | `AbortSignal` 取消 |
| `TimeoutError` | `ETIMEOUT` | 单次尝试超时（附 `timeoutMs`） |
| `NetworkError` | `ENETWORK` | 连接失败、断开、DNS 等传输层崩溃 |
| `HttpError` | `EHTTP` | HTTP 非 2xx（附 `status` 与 `response`） |
| `IpcError` | `EIPC` | IPC 传输层自身错误（无 invoke key、信封/连接失败等） |
| `TauriError` | `ETAURI` | Rust 侧返回 `Tauri-Response: error`（附 `command`、`payload`） |
| `PolicyError` | `EPOLICY` | 被策略拒绝（附 `reason`、`origin`、调用方透传的 `context`） |
| `ParseError` | `EPARSE` | 声明为 JSON 但解析失败 |

```ts
import { HttpError, TimeoutError } from 'unireq'

try {
  await request(url)
} catch (error) {
  if (error instanceof HttpError) {
    console.log(error.status, error.response?.body)
  } else if (error instanceof TimeoutError) {
    console.log(error.timeoutMs)
  }
}
```

也可以只判断 `error.code`，无需依赖具体类。

## 设计

### 请求流程

```text
input (string | options)
  -> 合并默认 headers / baseUrl / timeout / retry / fetchOptions
  -> query 序列化，拼出最终 URL
  -> policy 中间件（排在用户中间件之前）
  -> middleware 洋葱链（可改请求、可改响应）
  -> 每次尝试：创建 deadline（用户 signal + 超时）
  -> registry.resolve(url) 选择 Transport
  -> Transport.send() 得到 RawResponse
  -> 非 2xx -> HttpError
  -> 按 responseType 解码 -> ClientResponse
  -> 失败且可重试 -> 退避后重新走一次尝试
```

核心（core）完全不知道 HTTP 或 IPC 的存在；它只依赖 `Transport` 接口和 `RawResponse`。

### 目录结构

```text
unireq/
├─ package.json          # exports / types / build 脚本
├─ tsconfig.json         # strict + NodeNext
├─ tsconfig.build.json   # src -> dist
├─ tsconfig.test.json    # src + test -> dist-test
├─ src/
│  ├─ index.ts           # 对外入口，只导出必要 API
│  ├─ types.ts           # 请求/响应/Transport 类型
│  ├─ errors.ts          # 分类错误 + code
│  ├─ policy.ts          # allow/deny 白名单策略与中间件
│  ├─ core/
│  │  ├─ client.ts       # createClient / request 入口、中间件
│  │  ├─ prepare.ts      # 默认值、body、retry 归一化
│  │  ├─ execute.ts      # 单次发送 + 重试 + 错误映射
│  │  ├─ response.ts     # JSON/text/buffer 解码
│  │  ├─ url.ts          # baseUrl + query 序列化
│  │  ├─ headers.ts      # 大小写归一化与合并
│  │  └─ abort.ts        # deadline（超时 + AbortSignal）与退避
│  ├─ transport/
│  │  └─ registry.ts     # 传输层注册表
│  ├─ http/
│  │  └─ http-transport.ts
│  └─ ipc/
│     ├─ tauri-bridge.ts    # 宿主能力隔离层（key、fetch、callback、postMessage）
│     ├─ tauri-transport.ts # Tauri 2.x 信封 + 平台 URL + key 刷新
│     └─ tauri-client.ts    # createTauriClient / invoke / ipcRequest / listen
└─ test/
   ├─ helpers.ts         # 本地临时 HTTP server
   ├─ http.test.ts       # HTTP、query、解析、超时、取消、重试
   ├─ core.test.ts       # 默认值、中间件、自定义传输层
   ├─ policy.test.ts     # 默认 allow、deny 白名单、denySchemes、同源、context
   └─ tauri.test.ts      # 信封、二进制、错误、超时、key 刷新、listen
```

### 传输层扩展点

```ts
import { createClient, type Transport, type TransportRequest, type RawResponse } from 'unireq'

class MyTransport implements Transport {
  readonly name = 'my-transport'

  supports(url: URL): boolean {
    return url.protocol === 'my:'
  }

  async send(input: TransportRequest): Promise<RawResponse> {
    // input.url / method / headers / body / signal
    // 必须返回 { status, headers, body: Uint8Array }
    // 并在 signal 取消时尽快结束（销毁底层连接或拒绝 Promise）
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ ok: true }), 'utf8'),
    }
  }

  // 可选：client.close() 时调用
  async close(): Promise<void> {}
}

const client = createClient({ transports: [new MyTransport()] })
await client.request('my://local/resource')
```

- 新增传输层只需实现 `supports` + `send`，核心、错误、超时、重试、中间件都不用改。
- 注册表采用**后注册者优先**：后注册的适配器如果 `supports` 同一 scheme，会覆盖先前的实现。因此可以用自定义适配器替换内置的 `ipc://` 传输。
- 传输层只需要关心协议细节，不要重复实现默认值、超时、解析或重试。

## Tauri 2.x IPC

已内置，不需要自定义传输层。Electron 仍可通过上面的 `Transport` 接口自行扩展。

### 一行调用

```ts
import { createTauriClient } from 'unireq'

const tauri = createTauriClient()   // 默认 15s 超时
const result = await tauri.invoke<{ ok: boolean }>('my_cmd', { a: 1 })
const off = await tauri.listen('evt', (payload) => console.log(payload))
await off()
```

`createTauriClient` 会自动完成：

- Windows 使用 `http://ipc.localhost/<cmd>`（`useHttpsScheme: true` 时用 https），macOS / Linux 使用 `ipc://localhost/<cmd>`；
- `encodeURIComponent(cmd)`，命令里的 `:`、`|` 都会被编码；
- 请求头 `Content-Type`、`Tauri-Callback`、`Tauri-Error`（十进制 u32）、`Tauri-Invoke-Key`；不写 `Tauri-Request-Id`（2.x 不存在）；
- 响应靠 `Tauri-Response: ok | error` 区分，`error` 映射为 `TauriError`（code `ETAURI`，附 `command` 与 `payload`）；
- key 惰性获取与缓存，401/403 时刷新一次，默认超时兜底；
- 事件沿用 Tauri 自带 `transformCallback` + `invoke('plugin:event|listen')`，`runCallback` 注册表只复用不重造。

### 原始字节（资源类命令）

`ipc://` 不强制 JSON 解析。低层入口保留 `Tauri-Response` 与完整响应头，不会把业务错误变成异常：

```ts
const res = await tauri.ipcRequest<Uint8Array>('read_bytes', {
  body: { path: '...' },
  responseType: 'buffer',            // buffer -> Uint8Array/Buffer；arraybuffer -> ArrayBuffer
})

console.log(res.headers['tauri-response'])   // 'ok' | 'error'
const bytes = res.data
```

也可以直接走底层 client：

```ts
const res = await tauri.request<Uint8Array>({
  url: 'ipc://localhost/read_bytes',  // Windows 下自动改写为 http(s)://ipc.localhost
  method: 'POST',
  body: { path: '...' },
  responseType: 'buffer',
})
```

`invoke()` 默认 JSON；需要二进制又想要错误映射时用 `invokeRaw()`（默认 `responseType: 'buffer'`）。

### Key 获取与超时

- 浏览器环境导入库时立即 patch `Headers.prototype.set` 和 `window.fetch`，截获宿主自己 IPC 请求里的 `Tauri-Invoke-Key` 并缓存。
- 没有截获到时，`BrowserTauriBridge` 借 `window.__TAURI_INTERNALS__.postMessage` 发一次无害的 `plugin:event|unlisten` 探针兜底。
- Node 环境没有宿主，必须注入 bridge 或 `keyProvider`；拿不到 key 时快速抛 `IpcError`，不会永久 pending。
- `createTauriClient` 默认 15s 超时；key 不匹配时 Rust 侧静默丢弃，最终表现为 `TimeoutError`。
- HTTP 401/403 视为 key 失效，丢弃缓存并重试一次。

### 边界与限制

- **完全不用 `__TAURI_INTERNALS__` 不可行**：key 截获依赖宿主自身的 `fetch` / `Headers`，事件依赖 `transformCallback` + `runCallback`，探针依赖 `postMessage`。库已把这些收敛到 bridge 层，但无法绕开它们。
- **`ipc://` 不是 `asset:`**：Tauri 的资源/文件通常走 `asset:` 协议。用 `ipc://` 取资源的前提是后端有对应命令返回 bytes，不能直接当 asset 协议使用。
- isolation 模式的加密 IPC 未实现。
- Android 依赖 `postMessage` 路径，未在真实设备验证。
- key 截获必须发生在宿主第一次 IPC 之前；请把 `unireq` 的导入放在应用入口最前面。
- 库当前按 Node 库形态打包（默认 client 会静态导入 `node:http`），在 WebView 里打包需要为 Node 内置模块提供 stub。
- `createTauriClient` 同样接受 `policy` / `fetchOptions`；单次 `invoke` / `ipcRequest` 可以传 `context` 与 `fetchOptions`。
- 为后续 `VJConfig` 预留：白名单/黑名单可直接映射到 `policy`（`mode` / `allow` / `deny` / `denySchemes` / `allowSameOrigin`），其余请求前逻辑仍可用 `middlewares` / `tauri.use()` 扩展。

## 测试覆盖

`npm test` 会先编译 `src` 与 `test`，再用本地临时 HTTP server 跑 `node:test`：

- 成功响应、状态码、headers、raw body
- query 数组 / Date / null / undefined 序列化
- JSON / text / 二进制自动解析与 `responseType` 覆盖
- HTTP 非 2xx（`HttpError` + 原始响应）
- 空 JSON body、非法 JSON（`ParseError`）
- 超时（`TimeoutError`）
- `AbortSignal` 取消（`CancelError`，含已取消后立即返回）
- 5xx 重试与最终成功
- 连接失败（`NetworkError`）
- `baseUrl`、默认 headers、大小写覆盖、JSON body
- `fetchOptions` 默认值与单次覆盖
- 中间件洋葱顺序与请求/响应双向修改
- 策略：默认 allow、`deny` 白名单、`deny` 列表与 `denySchemes` 优先、`allowSameOrigin`、`PolicyError` 的 `reason` / `origin` / `context`
- 自定义 scheme 传输层、覆盖 `ipc://`、未知 scheme、非法相对 URL
- Tauri 信封（URL / 编码 / headers / body）、ok 与 error、原始字节与响应头
- Tauri 超时、invoke key 刷新与缺失时的快速失败、`listen` 注册/注销
- Tauri 中间件请求前拦截（为后续策略预留的钩子）

## 已知边界

- 不跟随 HTTP 重定向（3xx 会抛 `HttpError`）。
- 不提供 HTTP/2、cookie jar、代理配置。
- Tauri 的 isolation 加密 IPC、Android `postMessage` 路径、真实设备上的 key 截获时序未覆盖；这些场景只有 fake bridge 的单元测试。
- `ipc://` 不能替代 `asset:`；资源类命令需要后端显式返回 bytes。
- 响应 headers 统一小写，多值 header（如 `set-cookie`）以 `, ` 合并。
