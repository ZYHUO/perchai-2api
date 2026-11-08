# perchai-2api

把 Perch AI（[`perchai-cli`](https://www.npmjs.com/package/perchai-cli)）的托管模型网关反代成 **OpenAI 兼容的 2api** 服务。
逆向自 `perchai-cli@2.4.125`，**零运行时依赖**（纯 Node 18+ 内置模块），支持流式、工具调用、多账户、内置 OAuth 登录。

## 特性

- **OpenAI 兼容**：`/v1/chat/completions`（流式/非流式）、`/v1/models`、`/v1/embeddings`、`/v1/usage`，Cherry Studio / NextChat / one-api / new-api / curl 直接可用
- **内置登录**：`perchai-2api login` 自带 PKCE OAuth 流程，不需要装官方 CLI
- **并发控制**：per-account 上游信号量（默认 4 并发，`PERCH_MAX_CONCURRENCY` 可调），FIFO 排队
- **连接复用**：keep-alive 连接池，避免每次请求重新 TLS 握手
- **流式健壮性**：背压感知（drain）、客户端断开即中止上游、空闲超时、总超时
- **自动重试**：上游 401 → 刷新会话重试一次；408/425/502/503 → 退避重试一次
- **turn-ticket**：自动获取并续期 Perch 计量票据（`x-perch-turn-ticket`），失败降级不阻塞
- **多账户**：`PERCH_ACCOUNTS` 把不同 API key 映射到不同 Perch 账号，共用一套服务
- **限流**：`PERCH_RPM` 按 key 限速（固定窗口），返回 429 + Retry-After
- **会话自愈**：复用官方 CLI 的 `~/.perch/cli-auth-session.json`，自动 refresh token
- **日志**：每请求一行（状态/耗时/模型/tokens/账户），`PERCH_LOG_LEVEL` 控制

## 快速开始

```bash
# 方式 A：内置登录（推荐）
git clone https://github.com/ZYHUO/perchai-2api.git && cd perchai-2api
node bin/perchai-2api.js login     # 浏览器 OAuth，会话存 ~/.perch/cli-auth-session.json
node bin/perchai-2api.js serve     # 默认监听 0.0.0.0:8080

# 方式 B：复用官方 CLI 的登录
npm i -g perchai-cli && perch login
node bin/perchai-2api.js serve    # 或 npm start
```

客户端接入：

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer 任意key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-6.1-sol","messages":[{"role":"user","content":"你好"}]}'

# 流式
curl -N http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer 任意key" -H "Content-Type: application/json" \
  -d '{"model":"gpt-6.1-sol","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | 监听地址 |
| `PERCH_APP_URL` | `https://app.perchai.app` | Perch 后端地址 |
| `PERCH_MODEL_CALL_PROXY_TOKEN` | — | 直接用 access token 代替会话文件 |
| `PERCH_ACCOUNTS` | — | 多账户：`"sk-key1:/path/sess1.json,sk-key2:/path/sess2.json"` |
| `PERCH_2API_KEY` | — | 设置后客户端必须使用该 key |
| `PERCH_2API_ALLOW_ANY=1` | — | 允许任意非空 key（默认单账户模式即如此） |
| `PERCH_MAX_CONCURRENCY` | `4` | 每账户同时进行的上游模型调用上限 |
| `PERCH_RPM` | `0` | 每 key 每分钟请求数上限（0=关闭） |
| `PERCH_CONNECT_TIMEOUT_MS` | `10000` | 上游建连超时 |
| `PERCH_IDLE_TIMEOUT_MS` | `120000` | 流式响应 SSE 事件间隔超时 |
| `PERCH_TOTAL_TIMEOUT_MS` | `1800000` | 非流式请求总超时 |
| `PERCH_LOG_LEVEL` | `1` | `0`=安静 `1`=请求日志 `2`=调试 |

## 端点

| 端点 | 说明 |
|---|---|
| `GET /v1/models` | 模型列表（账号默认模型置顶，标记 `default:true`） |
| `POST /v1/chat/completions` | 聊天补全；支持 `stream`、`tools`、`tool_choice`、`response_format`、`max_tokens`、`reasoning_effort`、`stream_options.include_usage` |
| `POST /v1/embeddings` | 文本向量 |
| `GET /v1/usage` | Perch 用量透传 |
| `GET /healthz` | 健康检查（含账户/会话/队列状态） |

## 常用模型

Perch 托管：`gpt-6.1-sol`、`gpt-6.1-terra`、`gpt-6-astra`、`gpt-6-sol`、`gpt-6-luna`、`gpt-5-6-*`、`gpt-5.5`、`deepseek-v4-flash-0731`、`fw-kimi-k3`、`fw-glm-5-3`、`grok-4.7`

网关/聚合：`anthropic/claude-sonnet-4.6`、`xai/grok-4.5`、`z-ai/glm-5.3`、`moonshotai/kimi-k3`、`deepseek/deepseek-v4-pro` 等（取决于账号套餐）

`model` 参数原样透传为 `preferredModelId`，后端按账号套餐解析；不认识的 id 会被后端拒绝并返回其错误信息。

## 逆向要点（协议速览）

| 步骤 | 端点 | 说明 |
|---|---|---|
| 登录 | `GET {appUrl}/api/perch-terminal/cli-auth/config` | 返回 Supabase 地址 + anon key + OAuth providers |
| 换码 | `POST {supabaseUrl}/auth/v1/token?grant_type=pkce` | PKCE 授权码换会话 |
| 票据 | `POST {appUrl}/api/perch-terminal/turn-ticket` | `{surface:"cli", profile:"standard"}` → 计量票据 |
| 聊天 | `POST {appUrl}/api/perch-terminal/model-call` | `{request:{messages, tools, maxOutputTokens, ...}, runId, lane:"chat", preferredModelId, clientSurface:"cli"}` |
| 流式事件 | SSE | `answer_delta` / `reasoning_delta` / `tool_call_delta` / `tool_use_end` / `done` / `error` |

鉴权头：`Authorization: Bearer <supabase access token>` + `User-Agent: perchai-cli/<版本>` + `x-perch-locale: en`。

## 测试

```bash
npm test     # 16 个用例：mock 上游端到端（流式/工具/错误映射/并发上限/多账户/限流/向量/用量）
```

## Docker

```bash
docker build -t perchai-2api .
docker run -d -p 8080:8080 \
  -v $HOME/.perch:/root/.perch \
  perchai-2api
```

## 项目结构

```
bin/perchai-2api.js    CLI 入口（serve / login / status）
src/
  server.js            路由、流式管道、背压、日志、多账户解析
  perch.js             上游调用（信号量、重试、会话刷新）
  session.js           会话加载/刷新、turn-ticket、keep-alive 连接池
  login.js             内置 PKCE OAuth 登录
  translate.js         OpenAI ⇄ Perch 协议翻译、SSE 状态机
  limiter.js           信号量 + 固定窗口限流
  config.js            环境配置
test/
  mock-upstream.js     Perch 协议 mock（可独立运行）
  api.test.js          node:test 端到端用例
```

## 说明

- 会话过期自动刷新；上游 401 自动重试一次（与官方 CLI 行为一致）。
- turn-ticket 获取失败时降级为不带票据调用，不阻塞请求。
- 仅供个人使用，未内置 TLS；公网部署请自行加反向代理与访问控制。
- 本项目只包装你自己的 Perch 账号，不涉及任何第三方账户凭证的绕过。
