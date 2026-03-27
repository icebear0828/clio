# Core Agent Loop — Deep Dive

## SSE Streaming Protocol

Claude API 流式响应遵循 Server-Sent Events 标准，每个事件由 `event:` 和 `data:` 行组成，`\n\n` 分隔：

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_xxx","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"usage":{"input_tokens":1234,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":42}}

event: message_stop
data: {"type":"message_stop"}
```

### Tool Use 的 SSE 序列

当模型决定调用工具时，content block 类型变为 `tool_use`，参数通过 `input_json_delta` 碎片式传输：

```
event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_abc123","name":"Read","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"file_"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"path\": \"src/index.ts\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":89}}
```

关键：`input_json_delta` 的 `partial_json` 是 JSON 碎片，必须拼接完整后才能 parse。在 `content_block_stop` 时执行 `JSON.parse(accumulated)`。

### Thinking 的 SSE 序列

启用 extended thinking 后，thinking block 先于 text block 出现：

```
event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me analyze..."}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}
...
```

## client.ts — SSE Parser

```
fetch response.body (ReadableStream<Uint8Array>)
  → reader.read() 逐 chunk 读取
  → TextDecoder 解码为字符串
  → 追加到 buffer
  → split("\n") 拆行
  → 保留最后不完整行作为下次 buffer
  → 每个完整行:
      ├─ 不以 "data: " 开头 → 跳过 (event: 行, 空行)
      ├─ "data: [DONE]" → return (结束 generator)
      └─ JSON.parse → yield 事件对象
```

### 重试机制

```
attempt 0 → fetch
  ├─ 网络错误 (TypeError/ECONNREFUSED/ETIMEDOUT) → 等 1s → attempt 1
  ├─ 429/502/503/504 → 等 1s → attempt 1
  └─ 其他错误 → 直接抛出

attempt 1 → fetch
  ├─ 同上 → 等 3s → attempt 2
  ...

attempt 3 → fetch
  ├─ 任何错误 → 直接抛出 (不再重试)
```

超时策略：如果调用方传了 AbortSignal（来自 Ctrl+C 的 AbortController），用调用方的 signal。否则用 `AbortSignal.timeout(30000)` 做连接超时。

## agent.ts — 事件处理状态机

```
状态变量:
  current: StreamedBlock | null  ← 当前正在接收的 block
  contentBlocks: ContentBlock[]  ← 本轮完成的所有 blocks
  stopReason: string             ← 最终的 stop_reason
  md: MarkdownRenderer           ← 文本流式渲染器
  usage: UsageStats              ← 累计 token 用量

事件路由:

  "error" ──────────→ throw Error (中断流)

  "message_start" ──→ usage.inputTokens += message.usage.input_tokens

  "content_block_start"
    → current = { type, text:"", inputJson:"", id?, name?, thinking:"" }

  "content_block_delta"
    ├─ text_delta      → md.write(delta.text)    ← 实时输出到终端
    │                    current.text += delta.text
    ├─ input_json_delta → current.inputJson += delta.partial_json
    └─ thinking_delta   → stderr.write(dim(delta.thinking))  ← 暗色输出
                          current.thinking += delta.thinking

  "content_block_stop"
    ├─ thinking type → stderr.write("\n")  ← 换行分隔 thinking/text
    ├─ text type     → contentBlocks.push({type:"text", text})
    ├─ tool_use type → JSON.parse(inputJson) → contentBlocks.push({type:"tool_use",...})
    └─ thinking type → contentBlocks.push({type:"thinking",...})
    → current = null

  "message_delta" ──→ stopReason = delta.stop_reason
                      usage.outputTokens += event.usage.output_tokens

  流结束 → md.flush() + "\n"
```

## Tool Execution Pipeline

```
for each block where type === "tool_use":

  ① renderToolCall(name, input)
     └─ stderr: "  ▸ Read file_path="src/main.ts""

  ② renderDiff(old, new)  [仅 Edit 工具]
     └─ stderr: "    - old line" / "    + new line"

  ③ permissionManager.check(name, input)
     ├─ mode=auto → "allow"
     ├─ mode=plan + (dangerous|write) → "deny"
     ├─ safe tool → "allow"
     ├─ alwaysAllowed.has(name) → "allow"
     └─ 否则 → readline 提示:
         "  Allow Bash? [Y]es / [n]o / [a]lways > "
         ├─ Y/回车 → "allow"
         ├─ n → "deny"
         ├─ a → "allow" + alwaysAllowed.add(name)
         └─ Ctrl+C → "deny"

  ④ 如果 deny:
     renderPermissionDenied(name)
     push tool_result { is_error: true, content: "User denied..." }
     continue

  ⑤ startSpinner("Running Read...")

  ⑥ executeTool(name, input)
     switch(name):
       Read  → fs.readFile → 行号格式化
       Write → fs.mkdir + fs.writeFile
       Edit  → fs.readFile → indexOf → uniqueness check → 替换 → fs.writeFile
       Bash  → child_process.exec (timeout 120s, maxBuffer 10MB)
       Glob  → fast-glob (ignore node_modules/.git)
       Grep  → RegExp 构建 → 逐文件搜索 (max 300 matches)

  ⑦ stopSpinner()

  ⑧ renderToolResult(result, isError)
     └─ stderr: "  ✓ result..." (截断到 20 行)

  ⑨ push tool_result { tool_use_id, content, is_error? }
```

## Token Usage Tracking

token 数据从两个 SSE 事件中提取：

```
message_start.message.usage.input_tokens  → 本轮输入 token 数
message_delta.usage.output_tokens         → 本轮输出 token 数
```

在多轮 tool loop 中累加。最终返回给 index.ts 做 session 级汇总。

## Auto Context Compression

每轮循环开头检查：

```
estimateTokens(messages)  ← 粗略估算: 总字符数 / 4
  > 180,000 * 0.85 = 153,000 AND messages.length > 4?
    → compactConversation(config, messages)
      → 序列化 messages 为文本
      → 发送给 Claude 做摘要
      → 替换 messages 为 [summary, ack] 两条
```

失败时静默忽略，让 API 自行截断。
