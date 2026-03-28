中文 | [English](README.md)

# Clio — Claude Code CLI

功能丰富的 Claude Code 开源替代品，在终端中运行。连接 Anthropic API（或任何兼容端点），提供交互式智能编程助手，支持本地工具执行。

46 个源文件，约 9200 行 TypeScript。运行时零外部依赖（仅 `fast-glob`）。

## 快速开始

```bash
# 安装依赖
npm install

# 设置 API 密钥
export ANTHROPIC_API_KEY=sk-ant-xxx

# 直接运行（无需构建）
cd your-project
npx tsx /path/to/clio/src/index.ts

# 或者先构建
npx tsc
node dist/index.js
```

## 功能特性

- **Agent 循环** — 多轮工具调用：Claude 读取文件、编写代码、运行命令，迭代直到完成
- **21 个工具** — Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, Agent, AskUserQuestion, EnterPlanMode, ExitPlanMode, TaskCreate/Update/List/Get, Skill, ToolSearch, TeamCreate/Delete, SendMessage
- **流式输出** — 实时 Markdown 渲染，语法高亮代码块、标题、列表、行内格式
- **Prompt 缓存** — 系统提示词、工具、消息历史的 `cache_control`，节省约 90% 输入 token
- **模型感知上下文** — 按模型动态上下文限制（Opus 1M，Sonnet/Haiku 200k），85% 时自动压缩
- **权限系统** — 三种模式（default/auto/plan），Y/n/a 提示，正则允许/拒绝规则，两阶段自动分类器（模式匹配 + LLM），Shift+Tab 切换
- **上下文加载** — 自动加载 CLAUDE.md 文件（向上遍历）+ git 分支/状态/提交信息
- **会话管理** — 自动保存对话，`--resume <id>` 恢复，`--fork-session <id>` 分叉
- **Git 工作流** — `/commit`、`/pr`、`/review` 命令，AI 生成提交信息
- **MCP 支持** — 基于 stdio 的 JSON-RPC 2.0，服务器生命周期管理，`mcp__` 前缀工具发现
- **自定义 Agent** — 在 `.clio/agents/*.md` 中定义 agent，支持 front-matter（tools, model, max_iterations）
- **后台 Agent** — `run_in_background` 异步子 agent 执行，完成通知
- **Worktree 隔离** — 在隔离的 git worktree 中运行子 agent
- **Agent 团队** — TeamCreate/TeamDelete/SendMessage 实现 agent 间消息传递和协作
- **扩展思考** — 使用 `--thinking` 显示 Claude 的推理过程，自适应思考预算
- **图片输入** — 粘贴图片文件路径发送截图给 Claude
- **Hooks** — 通过 settings.json 配置工具执行前/后钩子，支持环境变量和工具过滤
- **插件系统** — 清单驱动的插件（plugin.json），支持 skills、agents、hooks、MCP、LSP、commands 注入
- **LSP 集成** — LspClient/LspManager，Content-Length 帧协议，诊断信息注入系统提示词
- **Skills** — Skill/ToolSearch 工具，延迟加载工具和内置 skill 执行
- **沙箱** — 路径限制、环境变量过滤、网络控制、资源限制
- **状态栏** — 可配置底部状态栏（模型/token/费用/模式/详细/会话）
- **语法高亮** — 支持 TS/JS/Python/Rust/Go/Bash/JSON/CSS/HTML 语言感知着色
- **撤销/重做** — 输入中 Ctrl+Z / Ctrl+Shift+Z，基于快照的撤销栈
- **检查点回滚** — Esc-Esc 恢复 Write/Edit 修改的文件
- **任务管理** — TaskCreate/Update/List/Get 跟踪多步骤工作流
- **智能截断** — Grep 分页（head_limit/offset），Bash 输出上限 500 行，Glob 分页
- **费用追踪** — `/cost` 命令 + 状态栏显示按模型计算的 USD 费用
- **打印模式** — `-p` 标志非交互输出，支持 JSON
- **快捷键** — 通过 keybindings.json 自定义键盘快捷键
- **OpenAI 兼容** — `--api-format openai` 支持任何 OpenAI 兼容端点

## 配置

### 命令行参数

```
--api-url <url>          API 基础 URL（默认：https://api.anthropic.com）
--api-key <key>          API 密钥
--api-format <fmt>       anthropic | openai（默认：anthropic）
--model <model>          模型名称（默认：claude-sonnet-4-20250514）
--resume <id>            恢复之前的会话
--fork-session <id>      从已有会话分叉
--thinking <tokens>      启用扩展思考并设置 token 预算
--permission-mode <mode> default | auto | plan
--allow <pattern>        自动允许匹配 glob 模式的 Bash 命令（可重复）
--deny <pattern>         始终拒绝匹配模式的 Bash 命令（可重复）
--allow-outside-cwd      允许文件工具访问工作目录外的路径
--dangerously-skip-permissions  允许所有工具无需提示
--no-color               禁用彩色输出
--version                显示版本
```

### 环境变量

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 |
| `ANTHROPIC_BASE_URL` | 自定义 API 基础 URL |
| `CLIO_API_KEY` | 网关 API 密钥（替代） |
| `CLIO_API_URL` | 网关 URL（替代） |
| `CLIO_MODEL` | 默认模型 |
| `NO_COLOR` | 禁用彩色输出 |

### 配置文件

4 级层次结构（后者覆盖前者）：

```
~/.clio/settings.json           全局配置（跨项目共享）
~/.clio/settings.local.json     全局密钥（gitignore — API 密钥）
.clio/settings.json             项目配置（提交，团队共享）
.clio/settings.local.json       项目密钥（gitignore，个人）
```

示例 `~/.clio/settings.json`：

```json
{
  "model": "claude-sonnet-4-20250514",
  "permissionMode": "default",
  "allowRules": ["npm *", "git *", "pnpm *"],
  "denyRules": ["rm -rf *"],
  "thinkingBudget": 0,
  "allowOutsideCwd": false,
  "hooks": {
    "pre": [
      { "command": "echo $CLIO_TOOL_NAME", "tools": ["Bash"], "timeout": 5000 }
    ]
  },
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["./mcp-server.js"]
    }
  }
}
```

数组（`allowRules`、`denyRules`、`hooks.pre`、`hooks.post`）跨层级拼接。标量值覆盖。

## 命令

| 命令 | 说明 |
|------|------|
| `/btw` | 快速旁问，不打断主对话 |
| `/clear` | 重置对话 |
| `/commit` | 生成提交信息并提交暂存更改 |
| `/compact` | 压缩对话上下文以减少 token 使用 |
| `/context` | 显示上下文窗口分析（按类别的 token、容量条） |
| `/cost` | 显示会话 token 使用量和 USD 费用 |
| `/doctor` | 系统健康检查（git、node、API、配置、工作目录） |
| `/exit` | 保存会话并退出 |
| `/help` | 显示命令列表和快捷键 |
| `/init` | 扫描项目并生成 CLAUDE.md |
| `/model [name]` | 显示或切换模型 |
| `/pr` | 生成 PR 标题/正文并通过 `gh` 创建 |
| `/review` | 代码审查当前 git diff |
| `/sessions` | 列出保存的会话 |
| `/settings` | 显示配置文件层次和合并后的配置 |
| `/theme` | 循环切换三种输出主题 |
| `/quit` | 退出（/exit 别名） |

## 输入

| 按键 | 操作 |
|------|------|
| `Enter` | 提交输入 |
| `Ctrl+J` / `Shift+Enter` | 插入换行（多行输入） |
| `Up` / `Down` | 命令历史（单行）/ 光标导航（多行） |
| `Tab` | 补全 `/` 命令或 `@文件` 引用 |
| `Ctrl+R` | 反向历史搜索 |
| `Ctrl+A` / `Ctrl+E` | 移到行首 / 行尾 |
| `Ctrl+W` | 向后删除一个词 |
| `Ctrl+K` | 删除到行尾 |
| `Ctrl+U` | 删除到行首 |
| `Ctrl+Y` | 粘贴（从 kill ring） |
| `Ctrl+Z` | 撤销上次输入更改 |
| `Ctrl+Shift+Z` | 重做 |
| `Ctrl+L` | 清屏 |
| `Ctrl+O` | 切换详细模式 |
| `Shift+Tab` | 循环权限模式（default → auto → plan） |
| `Ctrl+Left/Right` | 按词移动 |
| `Home` / `End` | 移到行首 / 行尾 |
| `Escape` | 取消生成或关闭菜单 |
| `Escape Escape` | 回滚上次检查点（撤销 Write/Edit 更改） |
| `Ctrl+C` | 取消输入或中断运行中的请求 |
| `Ctrl+D` | 退出（空行时） |
| 粘贴 | 自动检测多行粘贴 |

## 工具

| 工具 | 类别 | 说明 |
|------|------|------|
| Read | safe | 读取文件，支持行号、offset/limit |
| Glob | safe | 快速文件模式匹配，支持 head_limit/offset 分页 |
| Grep | safe | 正则搜索，支持 output_mode、head_limit、上下文行、type/glob 过滤、多行、大小写不敏感 |
| WebFetch | safe | 获取 URL，HTML 自动剥离为文本（默认 50k 字符） |
| WebSearch | safe | DuckDuckGo 网络搜索，可配置结果数量 |
| AskUserQuestion | safe | 在 agent 执行期间提示用户输入 |
| EnterPlanMode | safe | 切换到只读模式进行探索 |
| ExitPlanMode | safe | 恢复之前的权限模式 |
| TaskCreate | safe | 创建任务以跟踪进度 |
| TaskUpdate | safe | 更新任务状态或添加进度说明 |
| TaskList | safe | 列出所有任务及状态 |
| TaskGet | safe | 获取任务详情（含进度消息） |
| Skill | safe | 执行内置或插件 skill |
| ToolSearch | safe | 搜索并按需加载延迟工具 schema |
| TeamCreate | safe | 创建具有命名成员的 agent 团队 |
| TeamDelete | safe | 删除 agent 团队 |
| SendMessage | safe | 向团队中的另一个 agent 发送消息 |
| Write | write | 创建/覆盖文件（自动创建父目录） |
| Edit | write | 精确字符串替换，唯一性检查 |
| Bash | dangerous | 执行 shell 命令（120s 超时，10MB 缓冲区，500 行截断） |
| Agent | dangerous | 生成子 agent，可选 worktree 隔离和后台执行 |

**权限模式：**
- `default` — 安全工具自动允许，危险/写入工具提示 Y/n/a
- `auto` — 所有工具自动允许（无提示），拒绝规则仍生效
- `plan` — 安全工具允许，危险/写入工具静默拒绝

**允许/拒绝规则** 使用 glob 模式匹配 Bash 命令：
```bash
clio --allow "npm *" --allow "git status" --deny "rm -rf *"
```

## 自定义 Agent

在 `.clio/agents/` 中定义可复用的 agent 配置：

```markdown
<!-- .clio/agents/reviewer.md -->
---
tools: Read, Grep, Glob
model: claude-sonnet-4-20250514
max_iterations: 10
---

You are a code reviewer. Analyze the codebase for bugs, security issues, and style problems.
```

通过 Agent 工具使用 `subagent_type: "reviewer"` 调用。

## MCP 服务器

在 settings.json 中配置 Model Context Protocol 服务器：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-filesystem"]
    }
  }
}
```

MCP 工具以 `mcp__<server>__<tool>` 前缀出现，启动时自动发现。

## Hooks

在 settings.json 中配置，在工具执行前/后运行 shell 命令：

```json
{
  "hooks": {
    "pre": [
      { "command": "./validate.sh", "tools": ["Write", "Edit"], "timeout": 5000 }
    ],
    "post": [
      { "command": "echo done >> /tmp/clio.log" }
    ]
  }
}
```

- **Pre-hooks**：非零退出码阻止工具执行
- **Post-hooks**：非零退出码记录为警告，不阻止
- **环境变量**：`CLIO_TOOL_NAME`、`CLIO_TOOL_INPUT`（JSON）、`CLIO_HOOK_PHASE`
- **范围**：`tools` 数组限制哪些工具触发钩子（空 = 全部）

## 连接方式

```bash
# 直连 Anthropic API（默认）
export ANTHROPIC_API_KEY=sk-ant-xxx
clio

# OpenAI 兼容端点
clio --api-url https://my-proxy.com --api-key sk-xxx --api-format openai

# 自定义网关
clio --api-url http://localhost:3000 --api-key sk-xxx
```

## 会话

对话在每轮后自动保存到 `~/.clio/sessions/{id}.json`。

```bash
# 列出最近会话
clio    # 然后输入 /sessions

# 恢复会话
clio --resume a1b2c3d4

# 从已有会话分叉
clio --fork-session a1b2c3d4
```

## 项目结构

```
src/
├── index.ts                  入口，REPL，命令路由（17 个斜杠命令）
├── types.ts                  共享 TypeScript 类型
├── core/
│   ├── agent.ts              核心 agent 循环，prompt 缓存 + 模型感知上下文
│   ├── client.ts             SSE 流式客户端（Anthropic + OpenAI 格式）
│   ├── compact.ts            通过 API 进行对话摘要
│   ├── context.ts            系统提示词（环境、git、CLAUDE.md 向上遍历）
│   ├── permissions.ts        权限系统（3 种模式，允许/拒绝规则，自动分类器）
│   ├── pricing.ts            按模型 USD 费用估算
│   ├── session.ts            会话持久化 + 分叉（~/.clio/sessions/）
│   ├── settings.ts           4 级配置层次 + 合并
│   ├── system-prompt.ts      基于分区的系统提示词组装（静态 + 动态）
│   ├── section-cache.ts      会话级分区缓存
│   ├── billing.ts            Billing header 生成（x-anthropic-billing-header）
│   ├── prompts.ts            提示词模板
│   ├── normalize.ts          消息规范化（工具配对、图片/文档管理）
│   ├── adaptive-thinking.ts  动态思考预算调整
│   ├── sandbox.ts            沙箱（路径/环境变量/网络/资源限制）
│   └── llm-classifier.ts     两阶段自动分类器（模式匹配 + LLM Haiku）
├── tools/
│   ├── index.ts              21 个工具定义 + 本地执行 + 截断
│   ├── checkpoint.ts         文件快照 + 回滚（Write/Edit）
│   ├── hooks.ts              工具执行前/后钩子
│   ├── mcp.ts                MCP 客户端（基于 stdio 的 JSON-RPC 2.0）
│   ├── lsp.ts                LSP 客户端/管理器（Content-Length 帧协议，诊断）
│   ├── subagent.ts           子 agent 执行（迭代次数限制）
│   ├── tasks.ts              任务存储（进度追踪）
│   ├── teams.ts              Agent 团队（TeamCreate/Delete/SendMessage）
│   └── worktree.ts           Git worktree 创建/清理（隔离 agent）
├── ui/
│   ├── render.ts             ANSI 颜色、旋转器、diff 显示、工具特定渲染
│   ├── input.ts              原始模式终端输入（历史、粘贴、Tab、撤销/重做）
│   ├── markdown.ts           流式 Markdown → ANSI 渲染器
│   ├── highlight.ts          语法高亮（10 种语言）
│   ├── statusbar.ts          可配置底部状态栏
│   ├── image.ts              图片文件检测 + base64 编码
│   ├── keybindings.ts        可自定义键盘快捷键
│   └── file-completions.ts   @文件 Tab 补全（fast-glob 扫描）
├── plugins/
│   ├── types.ts              插件类型定义
│   ├── manifest.ts           plugin.json schema 和验证
│   ├── loader.ts             插件发现和加载
│   └── index.ts              插件系统入口
├── skills/
│   ├── index.ts              Skills 系统入口
│   ├── loader.ts             Skill 发现和加载
│   └── builtins/index.ts     内置 skill 定义
└── commands/
    ├── git-commands.ts        /commit、/pr、/review 实现
    ├── doctor.ts              /doctor 系统健康检查
    ├── init.ts                从项目扫描生成 CLAUDE.md
    └── custom-agents.ts       .clio/agents/*.md 加载器（front-matter 解析）
```

## 基准测试

详见 [A/B 基准测试：Clio vs Claude Code](benchmark/REPORT.md)，涵盖 5 种任务类型的延迟、token 使用、缓存效率和正确性对比。

## 许可证

MIT
