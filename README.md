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
- 会话内的**原生工具全部拒绝**（`permission: deny`）：模型只负责推理，工具的真正执行由 DSH 侧完成。
- 定时刷新模型目录（默认 15 分钟），刷新期间不会打断正在进行的对话。

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

- `lib/backend.js` — 定位可执行文件、启动隔离 serve、探测 API 版本、读取模型目录、执行一轮对话。
- `lib/catalog.js` — 从 provider 目录中筛出「全零成本」模型并映射为 DSH 模型条目。
- `lib/shim.js` — 把 DSH 的 OpenAI 请求桥接到 `backend.complete()`。
- `lib/protocol.js` — `{content, calls}` 结构化信封的编解码。
- `lib/index.js` — 插件入口：注册 adapter、provider 目录与模型发现。

### v1 / v2 探测规则

1. `GET /api/model` 返回 `application/json` → 判定为 **v2**；
2. 否则 `GET /global/health` 返回 `{ healthy: true }` → 判定为 **v1**；
3. 二者都不满足则继续等待（启动阶段最多 60 秒）。

## 疑难排查

- **模型列表为空**：先跑 `node bin/cli.js doctor` 确认能找到 `opencode`；再跑 `models` 确认你的 OpenCode 里确实存在成本为 0 的模型。
- **启动超时**：确认 `opencode serve` 能手工启动（`opencode serve --hostname 127.0.0.1 --port 4096`），并检查 `~/.dsh/dsh-connect-opencode-v2/startup-trace.log`。
- **自定义 provider 没有出现**：插件会把 `~/.config/opencode/opencode.json(c)` 与 `~/.local/share/opencode/auth.json` 复制进隔离目录，请确认这些文件存在。
- **端口冲突**：隔离 serve 使用系统分配的随机端口，通常不会冲突；若被防火墙拦截，请允许 `opencode` 监听回环地址。

## 日志

`~/.dsh/dsh-connect-opencode-v2/startup-trace.log` 记录启动、目录扫描与刷新事件。

## 许可与致谢

MIT。

本项目派生自 [serra006/dsh-connect-opencode](https://github.com/serra006/dsh-connect-opencode)（MIT），
将其 v1 专用后端改写为 v1/v2 双栈实现，因此无需外部包装器或转译层。
原作者的 MIT 许可证随仓库一并保留于 `LICENSE`。
