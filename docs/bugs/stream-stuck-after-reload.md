# 缺陷记录：刷新后正在流式输出的那一轮会卡住

**状态**：已修复（2026-10-30）
**影响版本**：在 `a160a99` 之前的所有版本
**影响范围**：页面刷新（`Cmd+R` / `Page.reload`）时正在流式输出的那一轮

---

## 一、症状

页面刷新之后，正在生成的那一轮回复**完全不动** ——
屏幕上只剩用户那条气泡，助手的内容一动不动，直到整轮结束才一次性全部出现。

不是「加载慢」，是**卡住**：中途没有任何增量上屏。

---

## 二、复现步骤

1. 打开应用，在一个对话里发一条会写长文的请求（比如「详细讲解幂等性，至少写 800 字」）
2. 等屏幕上出现一段内容（说明已经在流式输出）
3. 刷新页面（`Cmd+R`，或开发时用 CDP 的 `Page.reload`）
4. 观察屏幕上的正文长度

第 4 步（**在修复前**）会看到：内容先回退到只剩用户气泡，然后**长时间一动不动**，
直到这一轮结束才突然变成全文。

修复之后，第 3 步的回退仍然存在（见第七节），但第 4 步不会再卡住 ——
内容在 1.5 秒内就恢复并继续长。

---

## 三、实测数据

刷新后每 800 毫秒采样一次屏幕上的正文字数：

| 时间 | 字数 | 状态 |
|---|---|---|
| 1.5s | 22 | 流中 |
| 2.4s | 22 | 流中 |
| … | 22 | 流中 |
| 20.0s | 22 | 流中 |
| 20.8s | 22 | 流中 |
| **21.6s** | **2906** | 已结束 |

**卡了 19 秒。** 从 1.5 秒到 20.8 秒，字数一直是 22（只有用户气泡的长度），
21.6 秒那一轮结束时突然跳到 2906 字。

修复后同样的采样：

| 时间 | 字数 | 状态 |
|---|---|---|
| 1.5s | 1414 | 流中 |
| 2.4s | 1510 | 流中 |
| 12.0s | 1414 | 流中 |
| 19.2s | 2290 | 流中 |
| 24.0s | 3080 | 已结束 |

内容一路在长，不再卡住。

---

## 四、根因

在 `contract/stream.ts` 的 `applyEvent` 函数里，处理 `message_update` 事件的分支是这样写的：

```ts
case 'message_update': {
  if (data.type !== 'text_delta') return items
  const delta = typeof data.delta === 'string' ? data.delta : ''
  if (!delta) return items
  const last = items[items.length - 1]
  if (!last || last.kind !== 'message' || last.role !== 'assistant') return items   // ← 这里
  const next = items.slice()
  next[next.length - 1] = { ...last, text: last.text + delta }
  return next
}
```

**只有「最后一项是助手消息」时才追加，否则直接丢掉这个 delta。**

而页面刷新后，内容流是重新从磁盘读回来的（`getTabEntries` → `PiRuntime.readEntries`），
里面只有**已经落盘的消息**。

问题在于：**正在生成的那条助手消息还没进会话文件。**
Pi 的 `SessionManager` 只在 `message_end` 时才把消息 append 进去，
流式过程中的内容只存在于内存里，磁盘上没有。

所以刷新后：

- 内容流 = [用户消息]（最后一项是用户消息）
- 后续的 `message_update` 事件到达 → 最后一项不是助手消息 → **delta 全部丢弃**
- 直到 `message_end` 带来完整文本 → 一次性出现

---

## 五、修法

`message_update` 找不到助手消息项时，**补一个空壳再追加**：

```ts
case 'message_update': {
  if (data.type !== 'text_delta') return items
  const delta = typeof data.delta === 'string' ? data.delta : ''
  if (!delta) return items
  const last = items[items.length - 1]
  if (last && last.kind === 'message' && last.role === 'assistant') {
    const next = items.slice()
    next[next.length - 1] = { ...last, text: last.text + delta }
    return next
  }
  // 错过了 message_start —— 补一个空壳再追加
  return [...items, { kind: 'message', role: 'assistant', text: delta }]
}
```

### 为什么补一个空壳是安全的

**Pi 一次只流一条助手消息。** 所以「最后一项不是助手消息」只可能是
「缺了开头」（没收到 `message_start`），不可能是别的消息插在中间。

补一个空壳之后：

- 后续的 delta 继续往这一项上加
- `message_end` 到达时，它本来就是「替换最后一项」，不会多出一条

### 跟 `message_end` 保持一致

`message_end` 分支原本就有同样的兜底逻辑：

```ts
const index =
  last && last.kind === 'message' && last.role === 'assistant'
    ? items.length - 1
    : findLastAssistantIndex(items)
if (index < 0) {
  // 没有对应的助手消息项（没走到 message_start）—— 新建一条
  ...
}
```

也就是说：**`message_end` 早就考虑到「可能没收到 `message_start`」，但 `message_update` 没考虑。**
修复之后两处行为一致了。

---

## 六、回归测试

`tests/stream.test.ts` 里新增了一节「错过了 `message_start` 时的增量」，两个用例：

1. **最后一项不是助手消息时，delta 补一个新的助手项，而不是丢掉**
   - 初始只有用户消息
   - 第一个 delta → 多出一个助手项
   - 第二个 delta → 往同一项上累加
   - `message_end` → 用它带来的完整文本替换那一项，**不会多出一条**

2. **内容流是空的时候也一样** —— 第一个 delta 就建出一条助手项

---

## 七、没有修的：刷新时的内容回退

修复只解决「卡住」，**没有解决「刷新那一瞬间内容回退」**。

刷新后屏幕上的正文会掉到只剩用户气泡，然后重新长回来。

修复前后都能观察到这个回退，区别在于**恢复的速度**：

| | 刷新后 1.5 秒 | 什么时候恢复完整 |
|---|---|---|
| 修复前 | 22 字（还在卡） | 这一轮结束时（实测卡了 19 秒） |
| 修复后 | 1414 字（已经在长） | 一直在长，不等这一轮结束 |

**回退本身是结构性的，不是缺陷**：刷新时渲染进程的内存全清，只能从磁盘读；
而磁盘上没有正在生成的那条。要消除回退，得让 `getTabEntries` 同时返回
「已经落盘的」和「内存里正在生成的」，也就是改 `PiRuntime` 的读取接口。

代价是接口变复杂（要区分两种来源），收益只是「刷新时少闪一下」。
Electron 应用里用户通常不会刷新，所以没有做。

---

## 八、为什么没早点发现

这个缺陷**只在刷新时出现**，正常使用碰不到：

- 切标签时 `items[tabId]` 已经存在，不会重新读盘
- `reloadTab` 会先 `abort` 正在跑的那一轮，读完再重建
- 应用重启后 runtime 也是重建的，不会接着流

所以只有「页面刷新」这一条路径会触发 —— 开发时 `Cmd+R` 常见，但那时注意力通常在别处。

它属于「静默丢增量」：不报错、不提示，只是内容不动。
如果以后加了别的「重新读盘」的时机，同类问题会以别的形式再出现。
`docs/refresh-and-sync.md` 里记了所有触发点，新增读取时机时应该过一遍那份清单。

---

## 九、相关文件

| 文件 | 作用 |
|---|---|
| `contract/stream.ts` | `applyEvent` —— 事件套用到内容流的地方，缺陷和修复都在这 |
| `tests/stream.test.ts` | 回归测试 |
| `docs/refresh-and-sync.md` | 两条通道的触发点梳理，排查同类问题的入口 |
