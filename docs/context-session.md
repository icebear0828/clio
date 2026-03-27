# Context Management & Session Persistence

## System Prompt Construction (context.ts)

每次 API 请求都会构建 system prompt，包含三个部分：

```
buildSystemPrompt()
  ├─ ① 环境信息 (同步)
  ├─ ② Git 上下文 (async, 5s timeout)
  └─ ③ CLAUDE.md (async, 文件读取)

  ②③ 并行执行 (Promise.all)
```

### ① Environment Section

```markdown
# Environment
- Working directory: /home/user/project
- Platform: linux 6.1.0
- Shell: bash
- User: user
```

始终存在，无需异步操作。

### ② Git Context

三条 git 命令并行执行 (Promise.all)，每条 5s 超时：

```bash
git rev-parse --abbrev-ref HEAD    → branch name
git status --short                 → 工作区状态
git log --oneline -5               → 最近 5 次提交
```

组装结果:

```markdown
# Git Context
- Branch: feature/auth
- Working tree: 3 changed file(s)
\`\`\`
 M src/auth.ts
 M src/routes.ts
?? src/new-file.ts
\`\`\`

Recent commits:
\`\`\`
a1b2c3d Fix login redirect
e4f5g6h Add session middleware
\`\`\`
```

不在 git 仓库中 → 返回 null → 不包含此部分。

### ③ CLAUDE.md Loading

查找策略 — 从 cwd 向上遍历到文件系统根目录：

```
/home/user/project/subdir/   ← cwd
  ├─ 检查 CLAUDE.md
  └─ 检查 .claude/CLAUDE.md

/home/user/project/
  ├─ 检查 CLAUDE.md          ← 找到!
  └─ 检查 .claude/CLAUDE.md

/home/user/
  ├─ 检查 CLAUDE.md
  └─ 检查 .claude/CLAUDE.md  ← 找到!

/home/
  ...

/
  ...
```

所有找到的文件收集后**倒序排列**（root 级在前，cwd 级在后），拼接输出：

```markdown
# Instructions from ../../.claude/CLAUDE.md

(root-level instructions here)

---

# Instructions from CLAUDE.md

(project-level instructions here)
```

这样设计是因为最近（closest）的 CLAUDE.md 出现在最后，对模型影响最大（recency bias）。

## Context Compression

### Manual: /compact Command (index.ts + compact.ts)

```
/compact
  → if messages.length === 0: "Nothing to compact"
  → serializeMessages(messages):
      User: hello
      Assistant: Hi! How can I help?
      User: [Tool: Read({"file_path":"src/index.ts"})]
      Assistant: I see the file...
  → 发送到 Claude API (非流式, max_tokens: 4096):
      system: COMPACT_PROMPT
      user: serialized conversation
  → 响应解析 → summary text
  → messages = [
      { role: "user",      content: "Summary: ...(summary)..." },
      { role: "assistant", content: "Understood. I have the context..." },
    ]
```

COMPACT_PROMPT 要求：
- 关键决策
- 讨论过的代码变更
- 提到的文件
- 当前任务状态
- 继续工作需要的重要上下文
- 格式: 结构化 bullet points

### Automatic: Agent Loop Auto-Compact (agent.ts)

```
每轮循环开头:
  estimated = estimateTokens(messages)
    ← 遍历所有 message 的 content
    ← 累加: text.length + content.length + JSON.stringify(input).length
    ← ÷ 4 (粗略 char/token 比)

  if estimated > 180,000 × 0.85 (= 153,000) AND messages.length > 4:
    → 自动执行 compact
    → 失败静默忽略 (try/catch empty)
```

`messages.length > 4` 条件防止刚 compact 过的 2 条消息立刻又触发 compact。

## Session Persistence (session.ts)

### 存储位置

```
~/.c2a/sessions/
  ├─ a1b2c3d4.json
  ├─ e5f6g7h8.json
  └─ ...
```

### Session Data Schema

```json
{
  "id": "a1b2c3d4",
  "cwd": "/home/user/project",
  "model": "claude-sonnet-4-20250514",
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": [...] }
  ],
  "usage": {
    "inputTokens": 12345,
    "outputTokens": 6789
  },
  "createdAt": "2026-03-26T10:00:00.000Z",
  "updatedAt": "2026-03-26T10:15:00.000Z"
}
```

### Lifecycle

```
启动:
  new SessionManager(model) → 生成 8 字符 hex ID
  如果 --resume <id>:
    SessionManager.restore(id)
    → 读取 JSON 文件
    → 恢复 messages[], usage
    → 日志提示恢复成功

运行中:
  每次 agent loop 完成后:
    session.save(messages, usage).catch(() => {})
    → 确保 ~/.c2a/sessions/ 存在
    → 写入 JSON (覆盖)

退出:
  session.save() 最后保存一次
  → 输出 session ID 供下次 --resume 使用

查看历史:
  /sessions
    → SessionManager.list(10)
    → 读取目录中所有 .json
    → 按 updatedAt 降序排列
    → 取前 10 条
    → 显示: ID, model, 消息数, 更新时间, 工作目录
```

### 恢复

```bash
c2a --resume a1b2c3d4
```

恢复后，新的对话追加到原有 messages 上。会话 ID 变为新的（不覆盖原会话文件），但消息历史是延续的。

## Settings (settings.ts)

### 存储位置

```
~/.c2a/settings.json
```

### Schema

```json
{
  "apiUrl": "http://localhost:3000",
  "apiKey": "sk-c2a-xxx",
  "model": "claude-sonnet-4-20250514",
  "permissionMode": "default",
  "thinkingBudget": 0,
  "allowRules": ["npm *", "git *", "pnpm *"],
  "allowOutsideCwd": false
}
```

所有字段可选。CLI flags 和环境变量覆盖 settings.json。

### 优先级

```
CLI flag > 环境变量 > settings.json > 硬编码默认值
```

### 加载流程

```
main()
  → loadSettings()        ← 读 ~/.c2a/settings.json, 失败返回 {}
  → loadConfig(settings)  ← settings 作为默认值, CLI args 覆盖
  → 合并 allowRules: settings.allowRules + --allow flags
  → 传入 PermissionManager(mode, allowRules)
```

### /settings 命令

显示当前配置文件的内容和路径，不修改。编辑需直接编辑 JSON 文件。

## Git Commands (git-commands.ts)

### /commit

```
1. git status --porcelain → 无改动则退出
2. git diff --cached → staged diff
   └─ 无 staged → git add -u → 重试
3. git log --oneline -5 → 风格参考
4. 调 Claude API (非流式):
     "Generate a concise git commit message for this diff."
     + diff (前 15000 字符)
5. 展示 message, 提示:
     [Y]es → git commit -m "message"
     [e]dit → 手动输入新 message → commit
     [n]o → 取消
```

### /pr

```
1. git rev-parse --abbrev-ref HEAD → 当前分支
2. detectBaseBranch() → main 或 master
3. 验证: 不在 base 分支上, gh CLI 存在
4. 收集:
     git log base..HEAD --oneline → commits
     git diff base...HEAD --stat → diff stat
     git diff base...HEAD → full diff (前 12000 字符)
5. 调 Claude API:
     "Generate PR title and body"
     输出格式: "TITLE: ...\nBODY: ..."
6. 解析 TITLE/BODY, 展示预览
7. 确认后:
     git push -u origin branch (如果未追踪远程)
     gh pr create --title "..." --body "..."
8. 输出 PR URL
```

### /review

```
1. git diff --cached + git diff → 合并 diff
2. 无改动 → 退出
3. 构建 review prompt:
     "Review this code diff ({n} files changed). Look for:
      bugs, security, performance, code quality, error handling"
4. 注入到 messages[] 作为 user message
5. 调 runAgentLoop() → 流式输出审查结果
   (走完整 agent loop, 模型可调用工具进一步检查代码)
```

/review 与 /commit /pr 的区别: /review 注入对话历史并走 agent loop（支持后续追问），/commit /pr 是独立的一次性 API 调用。

## /init — CLAUDE.md Generation (init.ts)

### 项目信息采集

```
gatherProjectContext(cwd)
  ├─ 包管理文件 (各取前 3000 字符):
  │    package.json, Cargo.toml, go.mod, pyproject.toml, requirements.txt
  ├─ README (取第一个找到的，前 2000 字符):
  │    README.md, README.rst, README.txt, README
  ├─ 目录结构 (2 层深度, 前 80 个条目):
  │    fast-glob **, 忽略 node_modules/.git/dist/__pycache__
  ├─ Git remotes:
  │    git remote -v
  └─ 配置文件 (各取前 1500 字符):
       tsconfig.json, .eslintrc.json, vite.config.ts, next.config.js, Makefile
```

### 生成流程

```
1. 检查 CLAUDE.md 是否已存在 → 存在则报错
2. gatherProjectContext() → 项目上下文文本
3. POST /v1/messages (非流式):
     system: INIT_PROMPT
     user: "---\n\n{context}"
4. 解析响应 → 提取 text blocks
5. 写入 cwd/CLAUDE.md
6. 返回文件路径
```

INIT_PROMPT 要求生成:
- 项目概述 (1-2 句)
- 技术栈
- 关键命令 (build, test, lint, dev)
- 项目结构
- 代码约定
- 注意事项
- 格式: bullet points, 简洁
