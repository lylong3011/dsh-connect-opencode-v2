# dsh-connect-opencode-v2

把**本机 OpenCode** 的免费模型接入 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）模型选择器的独立插件。

> 与 `dsh-connect-opencode@0.1.x` 最大的区别：**原生支持 OpenCode v2 的 `/api/*` 接口，同时自动兼容 v1**。
> 因此不再需要任何包装器（wrapper exe）、v1→v2 转译垫片（shim）或对 `node_modules` 的手工改动。

---

## 功能

- 启动一个**隔离**的 `opencode serve`（独立 XDG 目录，不污染你日常的 OpenCode 配置），并以 HTTP Basic 认证访问。
- 自动识别服务端 API 版本：
  - **v2**（OpenCode Desktop / CLI ≥ 2.x）：使用 `/api/model`、`/api/session`、`/api/session/{id}/prompt` 等接口；
  - **v1**（`opencode serve` ≤ 1.x）：使用 `/provider`、`/session`、`/session/{id}/message` 等接口。
- 扫描目录中**全部成本为 0** 的免费模型，注册为 DSH provider `opencode-local`（显示名 `OpenCode Local`），模型 id 形如 `opencode-local/opencode/deepseek-v4.1-flash-free`。
- **真流式输出**：订阅 OpenCode 的 SSE 事件流（`session.text.delta`，约每 100 ms 一段），边生成边把正文推给 DSH。首字延迟从"整段生成完"降到"模型开始输出"（实测长回答 6.6 s 见字 / 13.0 s 收全）。带工具的桥接轮次会增量提取 JSON 信封中的 `content` 字段，工具调用在末尾一次性下发。
- 会话内的**原生工具全部拒绝**（`permission: deny`）：模型只负责推理，工具的真正执行由 DSH 侧完成。
- 定时刷新模型目录（默认 15 分钟），刷新期间不会打断正在进行的对话。
- serve 意外退出时自动冷重启并重试当前轮次（自愈），不必手动重启 DSH。

## 环境要求

- DeepSeek Harness（已安装 `@deepseek-ai/dsh-base` 等基础 bundle）。
- 本机已安装 OpenCode，满足其一即可：
  - `~/.opencode/bin/opencode(.exe)`
  - `%LOCALAPPDATA%\Programs\@opencodedesktop\resources\opencode-cli.exe`（OpenCode 桌面版自带 CLI）
  - `%LOCALAPPDATA%\opencode\opencode-cli.exe`
  - npm 全局包 `opencode-ai`
  - 或通过设置项 `binary` 指定绝对路径
- Node.js `^22.19.0 || >=24.0.0`。

## 安装

### 从本地目录安装

```powershell
dsh plugin --profile desktop add C:\Users\<you>\dsh-connect-opencode-v2
```

### 从 Git 仓库安装

```powershell
dsh plugin --profile desktop add git+https://github.com/lylong3011/dsh-connect-opencode-v2.git
```

安装后插件会写入 profile 的 `dsh.profile.bundles`。**重启 DSH** 后生效；随后在「设置 → 模型」中可看到 `OpenCode Local` 提供方与免费模型列表。

> 如果此前安装过 `dsh-connect-opencode`（v1 版）与本仓库的包装器/垫片，请先卸载旧插件并删除包装器，避免二者争用同一个 provider id：
> ```powershell
> dsh plugin --profile desktop remove dsh-connect-opencode
> Remove-Item "$env:USERPROFILE\.opencode\bin\opencode.exe" -Force   # 可选：旧的转译包装器
> ```

## 配置

设置命名空间 `dsh-connect-opencode-v2`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否向 DSH 提供该 provider。 |
| `binary` | `""` | `opencode` 可执行文件绝对路径；留空则按下文顺序自动探测。 |
| `autoRefreshMin` | `15` | 免费模型目录的自动重扫间隔（分钟），`0` 表示不自动刷新。 |

## 自检 CLI

插件附带一个无需启动 DSH 即可运行的诊断命令：

```powershell
# 探测本机 opencode 可执行文件
node bin/cli.js doctor

# 列出发现的免费模型（会真实启动一次隔离 serve）
node bin/cli.js models

# 逐个模型真实发一次请求，报告哪些可用、失败原因是什么
node bin/cli.js probe --timeout 30000

# 端到端跑一轮对话
node bin/cli.js chat "Reply with exactly: pong" --model opencode/big-pickle
```

`doctor` 输出示例：

```
ok: C:\Users\<you>\.opencode\bin\opencode.exe
```

`models` 输出示例：

```
  opencode/big-pickle  ctx=160000 out=32000 img=false tool=true
  opencode/deepseek-v4.1-flash-free  ctx=200000 out=32000 img=true tool=true
  ...
```

`chat` 输出示例：

```
using opencode/big-pickle
answer: pong
usage: {"prompt_tokens":3363,"completion_tokens":199,"total_tokens":3562,...}
```

## 工作原理

```
DSH (pi-ai)
   │  OpenAI /v1/chat/completions
   ▼
lib/shim.js            本地 OpenAI 兼容端点（仅监听回环）
   │  complete(request)
   ▼
lib/backend.js         自动识别 v1 / v2 的 OpenCode HTTP 客户端
   │  HTTP Basic
   ▼
opencode serve         隔离实例（独立 XDG + 受限 agent 配置）
```

- `lib/backend.js` — 定位可执行文件、启动隔离 serve、探测 API 版本、读取模型目录、执行一轮对话（含事件流订阅）。
- `lib/catalog.js` — 从 provider 目录中筛出「全零成本」模型并映射为 DSH 模型条目。
- `lib/shim.js` — 把 DSH 的 OpenAI 请求桥接到 `backend.complete()`，流式请求逐块下发。
- `lib/protocol.js` — `{content, calls}` 结构化信封的编解码，以及流式增量过滤（`createDeltaFilter`）。
- `lib/index.js` — 插件入口：注册 adapter、provider 目录与模型发现。

### 一轮对话的延迟构成

| 环节 | 实测 |
| --- | --- |
| serve 冷启动（每次 DSH 启动一次） | ≈ 1.3 s |
| 模型目录扫描 | ≈ 10 ms |
| 本地管道（建会话/设模型/设 agent/受理 prompt/删会话） | ≈ 50 ms |
| 上游排队到首个 token | 1–3.5 s（免费模型差异大） |
| 生成正文 | 视长度而定（约 20–40 token/s） |

本地这两跳可忽略不计，**耗时几乎全在上游**。因此优化的关键是"不要让用户等整段生成"：

- 正文通过 `/api/event` 的 `session.text.delta` 实时转发（OpenAI SSE chunk），首字即出现；
- 权威结果仍由 `GET /api/session/{id}/message` 轮询获得（150 ms 间隔），用于取完整文本、token 用量与上游错误；
- 事件流按规范是 "volatile by contract"（慢消费者会溢出断流），因此轮询始终保留，作为流不可用时的兜底。

### v1 / v2 探测规则

1. `GET /api/model` 返回 `application/json` → 判定为 **v2**；
2. 否则 `GET /global/health` 返回 `{ healthy: true }` → 判定为 **v1**；
3. 二者都不满足则继续等待（启动阶段最多 60 秒）。

## 疑难排查

- **模型列表为空**：先跑 `node bin/cli.js doctor` 确认能找到 `opencode`；再跑 `models` 确认你的 OpenCode 里确实存在成本为 0 的模型。
- **模型列表出现，但每个都不可用**：这是"目录里有、但调不通"，与插件无关，属于账号或网络问题。直接跑：
  ```powershell
  node bin/cli.js probe --timeout 30000
  ```
  它会逐个模型真实发一次请求，逐个报成功/失败原因。常见结论：
  - 全部 `FAIL ... fetch failed` / 超时 → 这台机器**连不上上游**（需要代理，或被网络策略拦截）；模型列表来自本地目录快照，所以"能列出来"不代表"能调用"。
  - `FAIL ... 403` / `RegionError` / "not available in your country" → 上游**地区封锁**，换模型或换出口网络。
  - `FAIL ... 401` / `unauthorized` → OpenCode 没有有效凭据，先在 OpenCode 里登录（`opencode auth list` 查看）。
  - 只有部分失败（例如某些推理型模型超时）→ 把 `--timeout` 调大再试。
- **启动超时**：确认 `opencode serve` 能手工启动（`opencode serve --hostname 127.0.0.1 --port 4096`），并检查 `~/.dsh/dsh-connect-opencode-v2/startup-trace.log`。
- **自定义 provider 没有出现**：插件会把 `~/.config/opencode/opencode.json(c)` 与 `~/.local/share/opencode/auth.json` 复制进隔离目录，请确认这些文件存在；v2 下还会用 `/api/provider`（活跃 provider）与目录取交集，没有活跃 provider 时不会注册任何模型。
- **端口冲突**：隔离 serve 使用系统分配的随机端口，通常不会冲突；若被防火墙拦截，请允许 `opencode` 监听回环地址。

## 日志

`~/.dsh/dsh-connect-opencode-v2/startup-trace.log` 记录启动、目录扫描与刷新事件。

## 许可与致谢

MIT。

本项目派生自 [serra006/dsh-connect-opencode](https://github.com/serra006/dsh-connect-opencode)（MIT），
将其 v1 专用后端改写为 v1/v2 双栈实现，因此无需外部包装器或转译层。
原作者的 MIT 许可证随仓库一并保留于 `LICENSE`。
