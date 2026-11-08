# perchai-2api

为 Perch AI 提供 OpenAI 风格的本地聊天接口，包含两种后端：

- **CLI 后端**：Docker Compose 默认使用它，实际运行未修改的 `perchai-cli@2.4.125 run --json`。支持文本会话和任务完成后的 SSE 格式返回；详细限制见下节。
- **HTTP 后端**：原有内部模型网关适配，纯 Node 18+ 内置模块。是否能够调用取决于上游访问权限；收到 `perch_surface_required` 时会停止，不会切换身份或自动改走 CLI。

CLI 后端需要 Node 22+ 和官方 CLI 的依赖，镜像会安装固定版本。接入依据是官方支持脚本调用的 [one-shot CLI 接口](https://www.perchai.app/docs/using-perch/cli)。请按账号获准的用途使用；CLI 可用不代表拥有直接 API、转售或对外共享授权。

## CLI 后端的能力和限制

使用下方 Docker Compose 步骤部署后，Base URL 为 `http://127.0.0.1:8080/v1`，Key 使用 `.env` 中的 `PERCH_2API_KEY`。客户端模型先选择 `auto` 或 `standard`。

| 能力 | CLI 后端行为 |
|---|---|
| 文本聊天 | 支持 string 和 text 内容块；每次请求使用独立工作目录与本地线程状态 |
| 多轮上下文 | 将 `messages` 序列化为 CLI 的一次任务输入；角色标签作为上下文，不保证原生模型 API 的指令优先级 |
| `stream:true` | 任务完成后返回 SSE，一次发送完整文本；响应头 `X-Perch-Stream-Mode: buffered`，并非逐 token 输出 |
| `stream_options.include_usage` | 返回 CLI 报告的本轮总用量，含 Perch 自带上下文；可包含缓存 token |
| 模型选择 | `/v1/models` 列出 `auto`、`standard`、`standard max`、`pro`、`pro max`；具体模型名称由官方 CLI 和账号权限决定 |
| `reasoning_effort` | 映射到 CLI 的 `--effort`，`none` 对应 `off` |
| 工具、图片、JSON schema、采样参数和输出 token 上限 | 不支持；参数出现时返回 400 `unsupported_parameter`，不会静默忽略 |
| `/v1/embeddings`、`/v1/usage` | 返回 501；账号用量请使用官方 CLI 的 `/usage` |
| 取消和超时 | 断开客户端会终止 CLI；默认 120 秒超时，每账号默认 1 个并发任务 |

使用 CLI 后端时，关闭客户端的工具调用，并删除请求中的 `max_tokens`、`max_completion_tokens`、`temperature`、`top_p`、`response_format` 等不受支持的字段。发送的最小请求是：

```json
{"model":"auto","messages":[{"role":"user","content":"你好"}]}
```

本地工具被 `--no-local-tools` 关闭，权限模式固定为 `plan`；临时工作目录在请求结束后删除。官方 CLI 自身的账号记忆、提示词和远端任务记录仍由 Perch 管理，此适配不是无状态的原始模型端点。多账户模式要求每个账号使用独立目录中的 `cli-auth-session.json`；CLI 后端不支持仅传 `PERCH_MODEL_CALL_PROXY_TOKEN`。

## HTTP 后端特性

- **OpenAI 兼容**：`/v1/chat/completions`（流式/非流式）、`/v1/models`、`/v1/embeddings`、`/v1/usage`，Cherry Studio / NextChat / one-api / new-api / curl 直接可用
- **内置登录**：`perchai-2api login` 自带 PKCE OAuth 流程，不需要装官方 CLI
- **并发控制**：per-account 上游信号量（默认 4 并发，`PERCH_MAX_CONCURRENCY` 可调），FIFO 排队
- **连接复用**：keep-alive 连接池，避免每次请求重新 TLS 握手
- **流式健壮性**：背压感知（drain）、客户端断开即中止上游、空闲超时、总超时
- **自动重试**：上游 401 → 刷新会话重试一次；408/425/502/503 → 退避重试一次
- **turn-ticket**：自动获取并续期 Perch 计量票据，失败立即停止；保留上游状态、错误码和 `stage: turn_ticket`，限流时返回 `Retry-After`
- **多账户**：`PERCH_ACCOUNTS` 把不同 API key 映射到不同 Perch 账号，共用一套服务
- **限流**：`PERCH_RPM` 按 key 限速（固定窗口），返回 429 + Retry-After
- **会话自愈**：复用官方 CLI 的 `~/.perch/cli-auth-session.json`，自动 refresh token
- **日志**：每请求一行（状态/耗时/模型/tokens/账户），`PERCH_LOG_LEVEL` 控制

## HTTP 后端快速开始

以下为 HTTP 模式，需要上游允许该调用方式。CLI 模式使用文末的 Docker Compose 部署步骤。

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
| `PERCH_BACKEND` | 源码 `http` / CLI 镜像 `cli` | 显式选择后端，不因请求被拒绝而自动切换 |
| `PERCH_CLI_ENTRY` | `/opt/perchai-cli/node_modules/perchai-cli/dist/perch.mjs` | 官方 CLI 入口 |
| `PERCH_CLI_TIMEOUT_MS` | `120000` | CLI 任务超时 |
| `PERCH_CLI_MAX_CONCURRENCY` | `1` | 每账号 CLI 并发上限 |
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
| `PERCH_TOTAL_TIMEOUT_MS` | `1800000` | 每次上游模型调用超时（含流式响应体） |
| `PERCH_LOG_LEVEL` | `1` | `0`=安静 `1`=请求日志 `2`=调试 |

## HTTP 后端端点

| 端点 | 说明 |
|---|---|
| `GET /v1/models` | 模型列表（账号默认模型置顶，标记 `default:true`） |
| `POST /v1/chat/completions` | 聊天补全；支持 `stream`、`tools`、`tool_choice`、`response_format`、`max_tokens`、`reasoning_effort`、`stream_options.include_usage` |
| `POST /v1/embeddings` | 文本向量 |
| `GET /v1/usage` | Perch 用量透传 |
| `GET /healthz` | 健康检查（含账户/会话/队列状态） |

## HTTP 后端候选模型

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
npm test     # 50 个用例：HTTP、票据拒绝、CLI 子进程、取消、超时及兼容性回归
```

## Docker

```bash
# CLI 镜像（Compose 默认目标）
docker build --target cli -t perchai-2api:local .
# 仅 HTTP 的轻量镜像
docker build --target runtime -t perchai-2api:http .
```

## 项目结构

```
bin/perchai-2api.js    CLI 入口（serve / login / status）
src/
  server.js            路由、流式管道、背压、日志、多账户解析
  perch.js             上游调用（信号量、重试、会话刷新）
  cli.js               官方 CLI 子进程、文本适配、参数校验、取消与超时
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
- turn-ticket 失败不会继续发模型请求；403 在本进程内短暂缓存 30 秒，429 尊重 `Retry-After`，避免持续重复被拒绝的请求。
- 仅供个人使用，未内置 TLS；公网部署请自行加反向代理与访问控制。
- 本项目只包装你自己的 Perch 账号，不涉及任何第三方账户凭证的绕过。

## Docker Compose 部署与修复说明

在项目目录先初始化配置和会话目录。以下命令仅用于首次部署，已有 `.env` 时不要覆盖：

```bash
umask 077
mkdir -p data
printf 'PERCH_2API_KEY=sk-perch-%s\nPERCH_MAX_CONCURRENCY=4\nPERCH_RPM=60\nPERCH_LOG_LEVEL=1\n' "$(openssl rand -hex 24)" > .env
# Compose 中服务以 UID/GID 1000:1000 运行，确保会话目录可写
sudo chown 1000:1000 data
docker-compose up -d --build
```

如果使用 Docker Compose v2，将下文 `docker-compose` 换成 `docker compose`。

- API Base URL：`http://127.0.0.1:8080/v1`。
- 容器：`perchai-2api`，`restart: unless-stopped`，非 root 用户运行。
- 客户端密钥保存在 `.env` 的 `PERCH_2API_KEY`，文件权限为 `600`。不要将该文件提交到版本库。
- 会话目录：`data/`，容器内为 `/data`；会话文件为 `data/cli-auth-session.json`。
- 已设置每分钟 60 次聊天请求、CLI 每账号 1 个并发，以及日志轮转；HTTP 后端的并发配置独立。
- `/healthz` 表示服务进程存活。带正确 API Key 请求时才返回当前账号会话及队列状态；进程健康不代表已经登录。

管理命令（在项目目录执行）：

```bash
docker-compose up -d --build
docker-compose ps
docker-compose logs --tail=100 -f
docker-compose restart
curl http://127.0.0.1:8080/healthz
```

之后登录：

```bash
./bin/login-docker.sh
# 可选 GitHub 登录：./bin/login-docker.sh --provider github
docker-compose restart
```

命令会输出浏览器登录链接，回调地址固定为 `127.0.0.1:18081`。如果浏览器在另一台电脑，在那台电脑先运行 `ssh -N -L 18081:127.0.0.1:18081 用户名@服务器地址`，保持隧道开启，再打开登录链接。登录脚本使用容器内的 Node，无需在宿主机安装 Node。

通过 SSH 从其他电脑调用 API，可以另开 `ssh -N -L 8080:127.0.0.1:8080 用户名@服务器地址`，然后使用本机 `http://127.0.0.1:8080/v1` 和 `.env` 中的 Key。

本次检查修复了以下问题，并补充了回归测试：

1. `npm test` 在 Node 22 下将测试目录当作入口模块，导致无法运行。
2. 内置登录错误解构 HTTP 响应、读取错误的 Supabase 令牌字段；无桌面浏览器时可能不输出登录链接；无关回调请求会中断登录。
3. 上游连接错误时请求挂起；客户端断开不能及时取消上游；总超时在收到响应头后失效；重试未释放旧连接。
4. 中文跨网络分块时乱码；重复工具调用快照变成多个调用；缺失完成事件被误报为正常结束。
5. 用量和向量接口首次请求未加载会话；模型列表未校验客户端密钥；健康检查泄露账号路径；多账号启动日志包含完整 API Key。
6. 并发信号量交接存在超额并发窗口；相同会话的多个 Key 未共享并发限制；新 turn-ticket 的 runId 未用于首次模型请求。

50 个测试使用本地 mock 上游和 CLI 子进程夹具，涵盖正常聊天、SSE、工具调用、票据拒绝、错误、取消、超时、并发、登录换码、账号路由和鉴权。可复现命令：

```bash
docker run --rm -v "$PWD:/app:ro" -w /app node:22-alpine npm test
```

自动测试不需要真实 Perch 账号。HTTP 模式的候选模型列表不代表账号有权使用全部模型；流式工具参数按 Perch 快照处理，在工具封口或完成事件时输出。CLI 模式的支持范围以上方能力表为准，不能用 HTTP 模式的测试结果推断 CLI 支持工具或向量。
