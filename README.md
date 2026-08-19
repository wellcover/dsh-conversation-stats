# dsh-conversation-stats

DeepSeek Harness（DSH）Web GUI 的**会话统计插件**：在顶部分栏「对话」「轨迹」之后新增 **「会话统计」** tab，列出 **每个对话** 的轮数、步数、模型调用次数与 token 用量（输入 / 输出 / 缓存），并汇总 LLM/工具耗时、模型分布、结束原因；**点击某个会话** 展开该对话的逐条模型调用明细与工具调用统计。数据每 60 秒自动刷新，也支持手动重新扫描。

数据直接解析 `~/.dsh/sessions/**/session.jsonl.zstd`（会话持久化日志，zstd 分帧），**无需常驻监听**——历史对话与当前对话同样可见，重启不丢，本人即可核对口径。

## 功能

- 📊 **顶部「会话统计」tab**（`conversation.view`，排在「对话」「轨迹」及用量插件的 tab 之后）
- 📋 **会话总览表**：标题/片段、轮数、步数、调用、输出 tok、输入 tok、缓存 tok、最后活跃，按最后活跃倒序
- 🧮 **汇总 chips**：会话数 / 总轮数 / 总步数 / 总模型调用 / 总 token
- 🔍 **点击会话看明细**：会话信息卡（ID、工作区、时间、轮/步/调用、token 构成、LLM/工具耗时、模型分布、结束原因）+ 工具调用表（次数/总耗时/失败数）+ 逐条模型调用明细表（时间/模型/结束原因/输入/输出/缓存/工具）
- ⏱️ **扫描时间显示** + 手动「刷新」（强制重扫）+ 60 秒自动刷新
- 🗑️ **彻底删除会话**（v1.0.2）：总览表最右侧「删除」列，经红色确认弹层后删除对应会话目录（`~/.dsh/sessions/…/<sessionId>`，含 `session.jsonl.zstd`），删除后自动重扫刷新列表

## 安装

```bash
cd dsh-conversation-stats
pnpm pack
dsh plugin --profile web add dsh-conversation-stats-1.0.2.tgz
```

装完**重启 `dsh web`**（或桌面应用重开）。`dsh plugin add` 会自动把包装进 profile、写入 `dsh.profile.bundles`，并随包的 `cordis.patch.yml` 挂载插件行。

手动安装（无 pnpm）：拷贝包到 `~/.dsh/profiles/web/node_modules/dsh-conversation-stats`，在 profile `package.json` 的 `dsh.profile.bundles` 追加 `"dsh-conversation-stats"`，并在 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: conversation-stats
      name: 'dsh-conversation-stats'
      inject:
        - fs
        - webServer
```

## 数据口径

- **轮数 turns**：含至少一个已关闭步（`step/end`）的不同轮次（与内置 `sessionStats` 投影一致）
- **步数 steps**：`step/end` 事件数（完成 / 失败 / 取消 / max-tokens 一并计入）
- **token**：`assistant/message` 事件的 `usage` 字段（`inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`；不同提供方可能缺某些字段，按 0 计）
- **LLM/工具耗时、首页延迟、解码 token**：与 `dsh-session-stats` 的 `sessionStats` 折叠同口径（`step/start`→`assistant/message`、`tool/call`→`tool/result` 配对）
- 会话按 `$DSH_HOME/sessions`（默认 `~/.dsh/sessions`）扫描，跨工作区一并列出（每行标注 cwd）

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 顶部无「会话统计」tab | 插件未激活：查看工作区下 `conversation-stats-boot.log`；确认 profile bundles 含本包并已重启 |
| 「会话统计加载失败」 | 宿主路由未注册：确认 `cordis.patch.yml` 行存在且 `inject` 含 `fs`/`webServer`，重启 |
| 列表为空 | `~/.dsh/sessions` 下没有 `.jsonl.zstd` 会话日志（或 DSH_HOME 指向别处） |

## 工作原理

- **Host 半**（`lib/index.js`）：Cordis 插件，注入 `fs / webServer`。将 `session.jsonl.zstd` 按 zstd magic 分帧、逐帧解压（Node `node:zlib` 对拼接流只解首帧，必须分帧），解析出新行分隔的 JSON 会话事件，按内置 `sessionStats` 同口径折叠统计；列表结果缓存 30 秒（`?refresh=1` 强制重扫）。
- **Client 半**（`lib/client.js`）：`window.__ModuleLoader__.load` 格式浏览器模块（React `createElement`、无 JSX/无构建），通过 `slots.inject("conversation.view")` 注册顶部 tab，轮询同源 `/conversation-stats/api` 与 `/conversation-stats/api/detail?id=…`。

## License

MIT