# Permission System & Tool Execution

## Permission Model (permissions.ts)

### Tool Categories

```
safe      → Read, Glob, Grep, WebFetch   只读操作，自动放行
dangerous → Bash                          任意命令执行
write     → Write, Edit                   文件修改
```

未知工具名默认归类为 `dangerous`。

### Decision Matrix

```
                    safe        dangerous     write
─────────────────────────────────────────────────────
mode=auto           allow       allow         allow
mode=plan           allow       deny(silent)  deny(silent)
mode=default        allow       prompt        prompt
  + alwaysAllowed   allow       allow         allow
  + allowPatterns   allow       allow*        prompt
```

*`allowPatterns` 仅匹配 Bash 工具的 `command` 字段。

### Allow Rules (--allow)

允许通过 glob 模式自动放行特定 Bash 命令，避免重复确认：

```bash
# CLI flags (可多次)
c2a --allow "npm *" --allow "git status" --allow "pnpm *"

# settings.json 持久化
{
  "allowRules": ["npm *", "git *", "pnpm *", "tsc *"]
}
```

**模式语法**:
- `*` → 匹配任意字符 (`.*`)
- `?` → 匹配单个字符 (`.`)
- 其他特殊字符自动转义
- 完整匹配: 模式两端加 `^...$`

**合并优先级**: settings.json 的 allowRules + CLI --allow，合并后去重

**检查流程** (仅 Bash 工具):

```
permissionManager.check("Bash", { command: "npm test" })
  → mode=auto? → allow
  → safe? → N (Bash = dangerous)
  → mode=plan? → deny
  → alwaysAllowed.has("Bash")? → allow
  → matchesAllowRule("npm test")? → 遍历 allowPatterns
      /^npm .*$/.test("npm test") → true → allow
  → 无匹配 → promptUser()
```

### Prompt Interaction

```
  ▸ Bash command="npm test"
  Allow Bash? [Y]es / [n]o / [a]lways > _

输入解析:
  ""  / "y" / "yes"   → allow (本次)
  "n" / "no"          → deny
  "a" / "always"      → allow + 记住 (session 级)
  Ctrl+C / Ctrl+D     → deny
```

### readline 冲突避免

主 REPL 的 InputReader 在 agent loop 执行期间处于**空闲状态**（已 pause stdin, 无 pending question）。
权限提示创建**临时** readline interface（output 指向 stderr），提问后立即 close。
两个 readline 不会同时活跃 → 无冲突。

```
timeline:

  InputReader.read() ────→ 返回输入
                           │
                           ▼
                     runAgentLoop() ──────────────────→ 返回
                       │                                 │
                       ├─ stdin paused, raw mode off     │
                       │                                 │
                       ├─ tool_use detected              │
                       │   └─ permissionManager.check()  │
                       │       └─ 临时 readline:          │
                       │           stdin resume           │
                       │           question → answer      │
                       │           readline.close()       │
                       │           stdin pause            │
                       │                                 │
                       └─────────────────────────────────┘
                           │
                           ▼
                     InputReader.read() ← stdin resume, raw mode on
```

### Denial Handling

拒绝时发送 tool_result:

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_abc",
  "content": "User denied permission to run Bash. Do not retry this tool call unless the user explicitly asks.",
  "is_error": true
}
```

`is_error: true` + 明确的 "do not retry" 指令防止模型无限重试被拒绝的工具。

## Workspace Restriction (tools.ts)

默认情况下 Read/Write/Edit 限制在 cwd 子树内：

```
assertInWorkspace(filePath):
  1. resolved = path.resolve(filePath)
  2. cwd = process.cwd()
  3. if !resolved.startsWith(cwd + path.sep) AND resolved !== cwd:
       → throw "Path outside workspace"
```

**解除限制**:
- CLI flag: `--allow-outside-cwd`
- settings.json: `"allowOutsideCwd": true`

适用工具: Read, Write, Edit（每个工具执行前调用 assertInWorkspace）。
Bash/Glob/Grep 不受此限制（Bash 通过权限系统控制，Glob/Grep 是 safe 类工具）。

## Tool Execution (tools.ts)

### Dispatch

```typescript
executeTool(name, input) → switch(name) → toolXxx(input)
```

单一入口，按名称分发。返回 string（成功结果或错误信息）。

### Read

```
输入: { file_path: string, offset?: number, limit?: number }
流程:
  1. assertInWorkspace(file_path)
  2. fs.readFile(file_path, "utf-8")
  2. split("\n") → lines[]
  3. start = max(0, (offset ?? 1) - 1)    ← 1-indexed 转 0-indexed
  4. end = limit ? start + limit : lines.length
  5. slice(start, end)
  6. map → "  {lineNum}\t{line}"           ← 6位右对齐行号 + tab
输出: 带行号的文件内容
```

### Write

```
输入: { file_path: string, content: string }
流程:
  1. fs.mkdir(dirname, { recursive: true })  ← 自动创建父目录
  2. fs.writeFile(file_path, content, "utf-8")
输出: "Successfully wrote {n} lines to {path}"
```

### Edit

```
输入: { file_path: string, old_string: string, new_string: string }
流程:
  1. fs.readFile → content
  2. content.indexOf(old_string) → idx
  3. if idx === -1 → throw "old_string not found"
  4. content.indexOf(old_string, idx + 1) → second
  5. if second !== -1 → throw "not unique"
  6. content = before + new_string + after
  7. fs.writeFile
输出: "Successfully edited {path}"

关键: 要求 old_string 在文件中**唯一出现**，
      避免替换到错误位置。
      这与 Claude Code 的 Edit 工具行为一致。
```

### Bash

```
输入: { command: string, timeout?: number }
流程:
  1. execAsync(command, {
       timeout: timeout ?? 120_000,        ← 默认 2 分钟
       cwd: process.cwd(),
       maxBuffer: 10 * 1024 * 1024,        ← 10MB
       shell: win32 ? "bash" : "/bin/bash", ← Windows 也用 bash
     })
  2. 组合 stdout + stderr
输出: stdout 内容 (+ stderr if exists)

错误处理:
  exec 失败 (非零退出码, 超时等):
    → 从 error 对象提取 stdout + stderr
    → 返回错误输出 (不 throw, 让模型看到错误)
```

### Glob

```
输入: { pattern: string, path?: string }
流程:
  1. fast-glob(pattern, {
       cwd: path ?? process.cwd(),
       ignore: ["**/node_modules/**", "**/.git/**"],
       dot: true,                           ← 包含隐藏文件
     })
输出: 文件路径列表 (每行一个) 或 "No files matched"
```

### Grep

```
输入: { pattern: string, path?: string }
流程:
  1. new RegExp(pattern)                    ← try-catch, 无效 regex 报错
  2. fs.stat(searchPath)                    ← .catch(() => null), 不存在报错

  单文件模式 (stat.isFile()):
    3. fs.readFile → lines
    4. 每行 regex.test() → 匹配的行 + 行号
    输出: "{lineNum}:{line}" 或 "No matches found"

  目录模式 (stat.isDirectory()):
    3. fast-glob("**/*", {
         ignore: node_modules, .git, dist
       })
    4. 逐文件读取:
       - 跳过二进制 (contains "\0")
       - 每行 regex.test()
       - 收集: "{relPath}:{lineNum}:{line}"
       - 达到 300 条 → 提前返回
    输出: 匹配结果列表 或 "No matches found"
```

## TOOL_DEFINITIONS

发送给 API 的工具 schema，让模型知道可以调用什么：

```typescript
[
  {
    name: "Read",
    description: "Reads a file from the local filesystem.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string" },    // required
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["file_path"],
    },
  },
  // Write: file_path + content (both required)
  // Edit: file_path + old_string + new_string (all required)
  // Bash: command (required) + timeout
  // Glob: pattern (required) + path
  // Grep: pattern (required) + path
]
```

### WebFetch

```
输入: { url: string, max_length?: number }
流程:
  1. fetch(url, { timeout: 15s, redirect: "follow" })
  2. 检查 Content-Type
     ├─ text/html → 去除 <script>/<style> → 去除所有 HTML 标签 → 解码实体 → 压缩空白
     └─ 其他 → 原始文本
  3. 截断到 max_length (默认 50000 字符)
输出: 页面文本内容

不受工作目录限制。归类为 safe 工具，自动放行。
```

## Hooks System (hooks.ts)

### 配置 (settings.json)

```json
{
  "hooks": {
    "pre": [
      { "command": "echo pre-hook", "tools": ["Bash", "Write"], "timeout": 5000 },
      { "command": "./check.sh" }
    ],
    "post": [
      { "command": "echo done", "tools": ["Edit"] }
    ]
  }
}
```

### HookConfig 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| command | string | 要执行的 shell 命令 |
| tools | string[] (可选) | 匹配的工具名，空 = 所有工具 |
| timeout | number (可选) | 超时毫秒数，默认 10000 |

### 执行流程

```
tool_use detected
  → renderToolCall()
  → permissionManager.check() → allow?
  → runHooks("pre", toolName, toolInput)
      for each pre hook:
        if hook.tools 非空 AND toolName 不在列表中 → 跳过
        execAsync(hook.command, {
          env: { C2A_TOOL_NAME, C2A_TOOL_INPUT (JSON), C2A_HOOK_PHASE },
          timeout: hook.timeout ?? 10000,
          cwd: process.cwd()
        })
        └─ 非零退出 → return false (阻止工具执行)
      → return true (放行)
  → executeTool()
  → runHooks("post", toolName, toolInput)
      └─ 非零退出 → 仅 warning 日志，不影响结果
```

### 环境变量

Hook 命令可通过环境变量获取上下文：

| 变量 | 说明 |
|------|------|
| C2A_TOOL_NAME | 工具名 (Read/Write/Bash 等) |
| C2A_TOOL_INPUT | 工具输入 (JSON 字符串) |
| C2A_HOOK_PHASE | "pre" 或 "post" |

### Pre vs Post 行为差异

| 方面 | Pre-hook | Post-hook |
|------|----------|-----------|
| 非零退出 | **阻止**工具执行，发 is_error tool_result | 仅 warning 日志 |
| 超时 | 同上 | 同上 |
| 目的 | 安全检查、审计、条件拦截 | 日志记录、通知、副作用 |

## TOOL_DEFINITIONS

发送给 API 的工具 schema，让模型知道可以调用什么。共 7 个工具:
Read, Write, Edit, Bash, Glob, Grep, WebFetch

这些定义同时发给网关。网关的 `wrapWithClaudeCodeShell` 会与 CC 工具合并去重（按 name），
客户端带 tools → `clientHadTools=true` → 网关直通代理（不走 gateway tool loop）。
