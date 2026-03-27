# CLI Architecture Overview

## Module Dependency Graph

```
index.ts ─────────────────────────────── 入口 + REPL + 命令路由
  ├→ agent.ts ───────────────────────── 核心 Agent Loop
  │    ├→ client.ts ─────────────────── SSE 流式 HTTP 客户端
  │    ├→ compact.ts ────────────────── 上下文压缩
  │    ├→ context.ts ────────────────── System Prompt 构建
  │    ├→ hooks.ts ──────────────────── Pre/post 工具执行钩子
  │    ├→ markdown.ts ───────────────── 流式 Markdown 渲染
  │    ├→ tools.ts ──────────────────── 7 工具定义 + 本地执行
  │    ├→ render.ts ─────────────────── ANSI 输出 (颜色/spinner/diff)
  │    └→ permissions.ts (type only) ── 权限管理器类型
  ├→ compact.ts
  ├→ git-commands.ts ────────────────── /commit /pr /review
  ├→ image.ts ───────────────────────── 图片路径检测 + base64
  ├→ init.ts ────────────────────────── /init CLAUDE.md 生成
  ├→ session.ts ─────────────────────── 会话持久化
  ├→ settings.ts ────────────────────── ~/.c2a/settings.json 读写
  ├→ statusbar.ts ───────────────────── 底部状态栏
  ├→ tools.ts (setAllowOutsideCwd) ─── 工作目录限制
  ├→ permissions.ts ─────────────────── 权限管理器 + allow regex
  ├→ input.ts ───────────────────────── 终端输入 (raw mode + Tab 补全)
  ├→ render.ts
  └→ types.ts ───────────────────────── 共享类型 (纯定义，零依赖)
```

## 无外部依赖模块

- `types.ts` — 纯类型
- `render.ts` — 纯 ANSI escape codes
- `input.ts` — Node.js readline + raw stdin + render.ts
- `context.ts` — Node.js fs + child_process
- `hooks.ts` — Node.js child_process + render.ts
- `image.ts` — Node.js fs
- `statusbar.ts` — render.ts + types.ts
- `tools.ts` — Node.js fs + child_process + fast-glob (唯一外部依赖)

## 请求完整生命周期

```
1. 用户输入
   InputReader.read(prompt)
     ├─ raw mode: 逐字符处理 / 粘贴检测 / 历史导航
     ├─ Tab: slash command 补全 (/co → /commit)
     └─ 返回: string | null (Ctrl+C/D)

2. 图片检测 (image.ts)
   parseInputWithImages(input)
     ├─ 无图片路径 → 返回原始 string
     └─ 有图片 → 返回 ContentBlock[] (image + text blocks)

3. 命令路由 (index.ts)
   ├─ /exit /clear /compact /cost /sessions /settings → 内部处理
   ├─ /commit /pr → git-commands.ts (独立 API 调用)
   ├─ /review → git diff 注入到 messages + agent loop
   ├─ /init → init.ts (扫描项目 + 生成 CLAUDE.md)
   ├─ /model → 切换模型 + 更新 statusBar
   └─ 普通文本 → push 到 messages[]

4. Agent Loop (agent.ts)
   ┌─────────────────────────────────────────┐
   │ while (iteration < 25)                   │
   │                                          │
   │   ① 自动 compact 检查                     │
   │      estimateTokens(messages)             │
   │      > 153k tokens? → compactConversation │
   │                                          │
   │   ② 构建请求体                             │
   │      { model, messages, tools,            │
   │        system: buildSystemPrompt(),       │
   │        thinking? }                        │
   │                                          │
   │   ③ 流式请求 (client.ts)                   │
   │      streamRequest() → AsyncGenerator     │
   │      ├─ message_start → 记录 input_tokens │
   │      ├─ content_block_start → 初始化 block │
   │      ├─ content_block_delta               │
   │      │   ├─ text_delta → md.write()       │
   │      │   ├─ input_json_delta → 拼接 JSON  │
   │      │   └─ thinking_delta → stderr 输出   │
   │      ├─ content_block_stop → 完成 block    │
   │      ├─ message_delta → stop_reason       │
   │      └─ error → throw                    │
   │                                          │
   │   ④ 检查 stop_reason                      │
   │      ├─ "end_turn" → return usage ────┐   │
   │      └─ "tool_use" → 继续 ↓           │   │
   │                                       │   │
   │   ⑤ 执行工具                           │   │
   │      for each tool_use block:         │   │
   │        renderToolCall()               │   │
   │        renderDiff() (if Edit)         │   │
   │        permissionManager.check()      │   │
   │        ├─ deny → tool_result(error)   │   │
   │        └─ allow:                      │   │
   │          runHooks("pre") ─ block?     │   │
   │          executeTool()                │   │
   │          runHooks("post")             │   │
   │          ├─ ok → tool_result          │   │
   │          └─ err → tool_result(error)  │   │
   │                                       │   │
   │   ⑥ messages.push(tool_results)       │   │
   │      → 回到 ①                          │   │
   └───────────────────────────────────────┘   │
                                               │
5. 结果处理 (index.ts)                          ←┘
   ├─ 累加 sessionUsage
   ├─ statusBar.update(sessionUsage)
   ├─ session.save()
   └─ 回到 1. 等待下一次输入
```

## 关键数据结构

### messages: Message[]

对话历史是整个系统的核心状态，在 index.ts 创建，传入 agent.ts 原地修改：

```typescript
// 用户文本
{ role: "user", content: "help me fix the bug" }

// 用户文本 + 图片
{ role: "user", content: [
  { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } },
  { type: "text", text: "What's wrong in this screenshot?" },
]}

// 助手文本回复
{ role: "assistant", content: [{ type: "text", text: "Let me look..." }] }

// 助手工具调用
{ role: "assistant", content: [
  { type: "text", text: "I'll read the file." },
  { type: "tool_use", id: "toolu_abc", name: "Read", input: { file_path: "src/main.ts" } },
]}

// 用户提交工具结果
{ role: "user", content: [
  { type: "tool_result", tool_use_id: "toolu_abc", content: "1\tconst x = 1;\n2\t..." },
]}

// thinking block (保留在历史中供 API 正确处理多轮)
{ role: "assistant", content: [
  { type: "thinking", thinking: "...", signature: "..." },
  { type: "text", text: "Here's what I found..." },
]}
```

### Config

```typescript
{
  apiUrl: "http://localhost:3000",     // 网关地址
  apiKey: "sk-c2a-xxx",               // 网关 API Key
  model: "claude-sonnet-4-20250514",   // 模型 ID
  permissionMode: "default",           // default | auto | plan
  thinkingBudget: 0,                   // 0 = 禁用, >0 = thinking token 预算
}
```

### Settings (持久化到 ~/.c2a/settings.json)

```json
{
  "apiUrl": "http://localhost:3000",
  "apiKey": "sk-c2a-xxx",
  "model": "claude-sonnet-4-20250514",
  "permissionMode": "default",
  "thinkingBudget": 0,
  "allowRules": ["npm *", "git *"],
  "allowOutsideCwd": false,
  "hooks": {
    "pre": [
      { "command": "echo pre", "tools": ["Bash"], "timeout": 5000 }
    ],
    "post": [
      { "command": "echo done" }
    ]
  }
}
```

优先级: CLI flag > 环境变量 > settings.json > 硬编码默认值

## 错误处理策略

| 层 | 策略 |
|----|------|
| 网络层 (client.ts) | 429/502/503/504 + 网络错误 → 最多 3 次指数退避重试 |
| SSE 解析 | JSON.parse 失败 → 静默跳过该行 |
| SSE error 事件 | 抛出异常，中断流 |
| 工具执行 (tools.ts) | 捕获异常 → is_error: true 的 tool_result |
| JSON 输入解析 (agent.ts) | try-catch → 回退 {_raw: 原文} |
| Agent loop (index.ts) | AbortError → "Interrupted" + 清理 messages |
| 自动 compact | 失败静默忽略 → 由 API 自行截断 |
| 会话保存 | .catch(() => {}) 静默忽略 |
| Pre-hook 失败 | 阻止工具执行，发 is_error tool_result |
| Post-hook 失败 | 仅 warning 日志，不影响结果 |

## 完整 Slash Commands

| 命令 | 实现 | 说明 |
|------|------|------|
| /clear | index.ts | 清空 messages[] |
| /commit | git-commands.ts | 生成 commit message → Y/e/n → git commit |
| /compact | index.ts + compact.ts | 序列化 → Claude 摘要 → 替换为 2 条消息 |
| /cost | index.ts | 显示 session 级 input/output token 统计 |
| /exit, /quit | index.ts | 保存会话并退出 |
| /help | index.ts | 显示命令列表和输入快捷键 |
| /init | init.ts | 扫描项目 → 生成 CLAUDE.md |
| /model [m] | index.ts | 显示/切换模型 + 更新 statusBar |
| /pr | git-commands.ts | 生成 PR title+body → 确认 → gh pr create |
| /review | git-commands.ts + agent.ts | diff 注入对话 → agent loop 流式审查 |
| /sessions | index.ts + session.ts | 列出最近 10 个会话 |
| /settings | index.ts + settings.ts | 显示配置文件路径和内容 |
