# Terminal I/O System

## Input System (input.ts)

### Raw Mode vs Cooked Mode

普通终端 (cooked mode): 系统缓冲一整行，按 Enter 才发给程序。
Raw mode: 每个按键立即发给程序，无缓冲，无回显。

CLI 用 raw mode 实现：
- 逐字符处理（回显、删除、光标移动）
- 方向键历史导航（Up/Down 是 escape sequences，cooked mode 下不可识别）
- 粘贴检测（单次 data 事件包含多字符）
- Ctrl+C 拦截（cooked mode 下直接杀进程）

### 按键 → 字节映射

```
按键            data chunk (hex / string)
─────────────────────────────────────────
a               "a" (0x61)
Enter           "\r" (0x0D) 或 "\n" (0x0A)
Backspace       0x7F 或 0x08
Tab             0x09
Ctrl+C          0x03
Ctrl+D          0x04
Ctrl+U          0x15
Up Arrow        "\x1b[A" (3 bytes: ESC [ A)
Down Arrow      "\x1b[B"
Right Arrow     "\x1b[C"
Left Arrow      "\x1b[D"
```

### InputReader.read() 流程

```
1. 检测 TTY
   ├─ 非 TTY (管道输入) → readFallback() 用 readline
   └─ TTY → 进入 raw mode

2. 初始化状态
   lines = [""]       ← 当前输入文本（支持多行）
   lineIdx = 0        ← 当前行号
   cursor = 0         ← 光标在当前行的位置
   savedHistoryIdx    ← 历史导航位置

3. 显示 prompt，监听 stdin "data" 事件

4. onData(chunk: Buffer) 处理:

   ─── 粘贴检测 ───
   if chunk.length > 1 AND 含 "\n":
     → 按 \r?\n 拆分
     → 第一段插入当前光标位置
     → 中间段逐行追加
     → 最后一段 + 原行剩余部分合并
     → 显示: "... " 续行提示
     → 如果粘贴以空行结尾 → 自动提交

   ─── 单字符处理 ───
   for each char in chunk:

     Escape sequence (\x1b[X):
       检查 i+2 < data.length (边界安全)
       A → Up: history 回退 (仅在首行时生效)
       B → Down: history 前进
       C → Right: cursor++, 输出 \x1b[C
       D → Left: cursor--, 输出 \x1b[D

     Ctrl+C (0x03): → resolve(null)
     Ctrl+D (0x04, 空行): → resolve(null)

     Backspace (0x7F/0x08):
       删除 cursor 前的字符
       redraw() 重绘当前行

     Enter (\r / \n):
       如果行尾是 "\\":
         → 删除 "\\"，新增空行
         → lineIdx++, cursor=0
         → 显示 "... " 续行提示
       否则:
         → resolve(lines.join("\n"))

     Ctrl+U (0x15): 清除光标前内容
     Tab (0x09): slash command 补全 (首行 / 开头) 或插入 2 空格
     普通字符 (code >= 32): 插入 + redraw

5. cleanup: 移除监听器, setRawMode(false), pause stdin
```

### redraw() 机制

```
当前行内容改变时需要重绘:

\r        ← 光标回到行首
\x1b[K    ← 清除从光标到行尾
{prompt}  ← 重写提示符 (首行: "> ", 续行: "... ")
{line}    ← 重写当前行文本
\x1b[{n}D ← 光标左移到正确位置 (如果 cursor < line.length)
```

### 历史导航

```
history: string[] = []     ← 所有历史输入
historyIdx: number         ← 当前会话的下一个插入位置

每次成功提交 (非空):
  history.push(input)
  historyIdx = history.length

Up Arrow:
  if savedHistoryIdx > 0:
    savedHistoryIdx--
    lines[0] = history[savedHistoryIdx]
    redraw()

Down Arrow:
  if savedHistoryIdx < history.length:
    savedHistoryIdx++
    lines[0] = (idx < length) ? history[idx] : ""
    redraw()
```

### 粘贴 vs 手动输入的区分

```
手动输入:  每个按键 → 独立 data 事件 → chunk.length === 1
粘贴:      所有字符 → 一次 data 事件 → chunk.length > 1 且含 \n

判定条件: data.length > 1 && data.includes("\n")
  → true: 粘贴模式，拆分插入
  → false: 逐字符处理
```

## Output System

### 输出流分离

```
stdout ← Claude 的文本回复 (通过 MarkdownRenderer)
stderr ← 一切 UI 元素:
         - 工具调用提示 (renderToolCall)
         - 工具结果 (renderToolResult)
         - Spinner 动画 (startSpinner)
         - 权限提示 (promptUser)
         - 权限拒绝 (renderPermissionDenied)
         - Diff 展示 (renderDiff)
         - Thinking 输出
         - 错误信息 (renderError)
```

这样设计的原因: 管道场景下 `c2a | tee output.txt` 只捕获 Claude 的回复文本，UI 元素不会混入。

### ANSI 色彩系统

```
colorsEnabled 判定:
  process.stdout.isTTY !== false   ← 是终端
  AND !process.env.NO_COLOR        ← 未设置 NO_COLOR
  AND !process.argv.includes("--no-color")

颜色函数工厂:
  esc(code) → (s) → colorsEnabled ? "\x1b[{code}m{s}\x1b[0m" : s

导出:
  dim      → \x1b[2m   (暗色)
  bold     → \x1b[1m   (粗体)
  red      → \x1b[31m
  green    → \x1b[32m
  yellow   → \x1b[33m
  cyan     → \x1b[36m
  magenta  → \x1b[35m
  boldCyan → \x1b[1;36m (组合)
```

### Markdown 流式渲染

```
文本流:  "# Hello\nSome **bold** text\n```js\nconst x = 1;\n```\n"

逐字符到达 → write() 缓冲 → 遇到 \n 时处理一行:

"# Hello"         → bold("Hello")
"Some **bold**..." → "Some " + bold("bold") + " text"
"```js"           → inCodeBlock=true, dim("  ```js")
"const x = 1;"    → cyan("  const x = 1;")     ← 代码块内容
"```"             → inCodeBlock=false, dim("  ```")

渲染规则 (按优先级):
  1. ``` fence → 切换 code block 状态
  2. code block 内 → cyan + 缩进
  3. # heading → bold
  4. > blockquote → dim("│") + dim(text)
  5. --- → dim("─" × 40)
  6. - / * / + list → dim("•") + text
  7. 1. ordered list → dim("1.") + text
  8. 普通文本 → inlineFormat()

行内格式 (inlineFormat, 按顺序):
  `code` → cyan(code)
  ***bold italic*** → bold(text)
  **bold** → bold(text)
  *italic* → dim(text)       ← 用 lookbehind/ahead 避免匹配 **
  ~~strikethrough~~ → dim(text)
```

### Spinner 动画

```
帧序列: ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏  (braille pattern)
间隔: 80ms

启动: setInterval → stderr: "\r  {cyan(frame)} {dim(message)}"
停止: clearInterval + stderr: "\r\x1b[K" (清除行)

非 TTY 时: 直接输出一行文本，返回 no-op 停止函数
```

## Tab Completion (input.ts)

输入以 `/` 开头时，Tab 触发 slash command 补全：

```
已注册命令:
  /clear /commit /compact /cost /exit /help
  /init /model /pr /review /sessions /settings /quit

处理逻辑:
  Tab pressed AND lines[0].startsWith("/") AND lineIdx === 0:
    matches = SLASH_COMMANDS.filter(c => c.startsWith(currentText))
    ├─ 恰好 1 个匹配 → 自动补全，更新行和光标
    ├─ 多个匹配 → 换行显示候选项 (dim)，重新显示当前输入
    └─ 无匹配 → 无操作

  否则 (非 slash command):
    → 插入 2 空格 (缩进)
```

示例：
```
> /co<Tab>
  → 匹配 /commit /compact /cost
  → 显示: /commit  /compact  /cost
  → 保持输入 /co 等待用户继续输入

> /com<Tab>
  → 匹配 /commit /compact
  → 显示候选

> /commi<Tab>
  → 唯一匹配 /commit
  → 自动补全为 /commit
```

## Image Input (image.ts)

检测用户输入中的图片文件路径，转换为 API 的 image content block：

```
parseInputWithImages(input: string)
  → 快速检查: input 中是否包含 .png/.jpg/.jpeg/.gif/.webp
  → 否 → 返回原始 string

  → 是 → 按空格拆分 tokens
    for each token:
      ext = path.extname(token)
      if ext in IMAGE_EXTENSIONS:
        resolved = path.resolve(token)
        fs.access(resolved) → 存在?
          ├─ 是 → 加入 imagePaths[]
          └─ 否 → 加入 textParts[] (当作普通文本)
      else:
        加入 textParts[]

  → imagePaths 为空 → 返回原始 string
  → 构建 ContentBlock[]:
      [
        { type: "image", source: { type: "base64", media_type, data } },
        ...
        { type: "text", text: textParts.join(" ") || "What is in this image?" },
      ]
```

MIME 映射:
```
.png  → image/png
.jpg  → image/jpeg
.jpeg → image/jpeg
.gif  → image/gif
.webp → image/webp
```

## Status Bar (statusbar.ts)

底部固定状态栏，使用 ANSI scroll region 实现：

```
┌──────────────────────────────────────┐
│ (正常终端内容在这里)                    │
│ > 用户输入                             │
│ Claude 的回复...                       │
│                                      │
├──────────────────────────────────────┤
│ claude-sonnet-4    1.2k tokens  a1b2 │ ← 状态栏 (固定在底部)
└──────────────────────────────────────┘
```

### 实现原理

```
初始化 (init):
  rows = process.stdout.rows
  \x1b[1;{rows-1}r    ← 设置 scroll region 为第 1 行到倒数第 2 行
                        最后一行不在 scroll region 内，不会被滚动覆盖

渲染 (render):
  \x1b7                ← 保存当前光标位置
  \x1b[{rows};1H       ← 移动光标到最后一行第 1 列
  \x1b[K               ← 清除该行
  {dim(status_text)}   ← 写入状态信息
  \x1b8                ← 恢复光标到之前位置

内容格式:
  左侧: model name
  右侧: token count + session ID
  中间: 空格填充到终端宽度

resize 处理:
  process.stdout.on("resize") → 重新设置 scroll region + 重新渲染

销毁 (destroy):
  \x1b[r               ← 重置 scroll region 为全屏
  清除最后一行
```

### 更新触发点

```
statusBar.init(model, sessionId)    ← 启动时
statusBar.update(usage)             ← 每次 agent loop 完成后
statusBar.updateModel(model)        ← /model 切换时
statusBar.destroy()                 ← 退出时
```

非 TTY 或 NO_COLOR 环境下，StatusBar 所有方法为 no-op。
