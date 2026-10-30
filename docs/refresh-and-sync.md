# 刷新与同步

这份文档梳理 Codelet 应用端「什么时候会重新读数据」，以及两条数据通道各自的触发点。
排查「界面没更新」「内容对不上」这类问题时，从这里的触发点清单往下查。

文中提到的代码位置都相对仓库根目录。

---

## 一、两条通道

应用端有两份状态，走两条不同的路。它们的**权威来源不同**，所以触发点和失效方式也不同。

| | 快照（`HostSnapshot`） | 内容流（`StreamItem[]`） |
|---|---|---|
| 存什么 | 项目清单、会话列表、标签栏、活动标签的会话状态 | 对话里的一条条消息和工具调用 |
| 权威来源 | 磁盘上的会话文件 + 宿主内存 | Pi runtime 的内存状态 |
| 主进程 → 渲染进程 | `IPC_EVENTS.snapshot`（整份替换） | `IPC_EVENTS.session`（增量，16ms 合批） |
| 渲染进程接收入口 | `store.setSnapshot` | `store.applySessionEvents` / `store.setItems` |

**关键区别**：快照是「重读磁盘」，内容流是「跟着 Pi 的事件长」。

由此产生一个后果：会话文件在**别的进程**里变了（比如在终端里跑裸 `pi`），
快照能看到（重读磁盘），内容流看不到（它读的是 runtime 内存）。
这一条见第四节。

---

## 二、快照的刷新触发点

宿主状态（`host/main/state.ts`）是快照的权威。它的刷新有四个来源。

### 1. Pi 事件驱动

主进程订阅自己的 `PiRuntime` 事件（`HostState.init` 里注册）。四类事件触发刷新：

| 事件 | 触发什么 |
|---|---|
| `model_select` | 立刻 `readSession()` + `push()` —— 模型被扩展改了 |
| `message_end`（role 是 `user`） | 排一次去抖刷新 |
| `agent_settled` | 排一次去抖刷新 + `markWritten()` |
| `entry_appended` / `session_info_changed` | 排一次去抖刷新 |

判定函数在 `host/main/conversationRefresh.ts` 的 `affectsConversationList`。

**只认用户消息**：助手消息和工具结果写的是同一个文件，跟着用户消息一起落盘，
不需要为它们单独触发刷新。

**为什么要去抖并延后 100ms**：Pi 是**先发事件、后写盘**的。
看到事件就立刻读盘，读到的还是旧列表 —— 新会话会「看不见」。

### 2. 用户操作驱动

| 操作 | 做什么 |
|---|---|
| `openProject()` | 加进项目清单 → 重读会话 → 开一个新标签 |
| `addProject(path)` | 加进清单 → 重读会话 |
| `removeProject(path)` | 从清单移除 → 重读会话 |
| `activateTab(tabId)` | 建 runtime（懒加载）→ `readSession()` → 可能补上 `tab.path` |
| `closeTab(tabId)` | 关 runtime → 活动标签落到相邻的 → `readSession()` |
| `reloadTab(tabId)` | 重建 runtime → 重新读内容流 |
| `selectModel(...)` | 切模型 → `readSession()` |

### 3. 窗口焦点

`host/main/index.ts` 里挂了 `win.on('blur')` 和 `win.on('focus')`：

- `blur` 记下时刻（`noteBlur()`）
- `focus` 时算「离开了多久」，**≥ 3 秒才重读**（`refreshOnFocus()`）

三条保护：

- 离开不足 3 秒不读 —— 点一下别的窗口又点回来不值得付重读的代价
- 同一次离开只触发一次（`blurredAt` 被消费掉）
- `init()` 跑完之前不响应（`initialized` 标志），因为 init 自己会读一次

这条存在的理由见第四节：别的进程写会话文件时，我们收不到事件。

### 4. 启动

`init()` 里无条件读一次会话列表，然后恢复标签。
恢复完把 `initialized` 置真、`blurredAt` 清掉。

---

## 三、内容流的刷新触发点

内容流存在渲染进程的 store 里，按标签 id 分桶（`items: Record<tabId, StreamItem[]>`）。

| 时机 | 机制 | 位置 |
|---|---|---|
| **切标签** | 该标签还没加载过时才 `getTabEntries` 读盘 | `App.tsx` 的 effect |
| **实时流** | `onSessionEvent` → 按 `tabId` 分桶 → 增量套用 | `store.applySessionEvents` |
| **重新加载** | 重建 runtime + `getTabEntries` 重读 | `store.reloadTab` |

**切标签不重建内容流**。它读的是内存里那一份，因为磁盘上的 entries 落后于实时事件 ——
拿磁盘覆盖会丢消息或重排。

**内容流不读磁盘**。`getTabEntries` 走的是 `PiRuntime.readEntries`，
读的是 `runtime.session.sessionManager.getBranch()`，那是 runtime 内存里的状态。

---

## 四、边界与已知问题

### 两个进程写同一个会话时，内容流不会更新

`SessionManager.open()` 只在构造时把文件读进内存，之后不再重读。
在终端里跑裸 `pi` 往同一个会话写了东西，Codelet 这边的 runtime 完全不知道。

检测方式：比对文件 mtime 和标签的 `seenMtime`（`state.checkStale`）。
文件比它新就是 `stale`。

**不自动重载**。重建 runtime 会丢掉当前状态，而且如果别处还在写，重建完很快又落后。
标出来让用户点「重新加载」，重载之前挡住输入（runtime 还是旧上下文，发消息会冲突）。

### 自己写文件不能把自己标成 stale

`agent_settled` 时调 `markWritten(tabId)`，把 `seenMtime` 推到当下。
不推的话，用户发一条消息就会看到「这个会话在别处有更新」。

### 会话列表只读清单里的项目

`refreshConversations` 读的是 `projects.list()` 里那几个目录，不是 `SessionManager.listAll()`。
所以刷新成本跟「选了几个项目、它们有多少会话」成正比。

参考量级：4 个项目、21 个会话，一次重读约 180ms（在主进程上）。

### 快照是整份替换，不是增量

每次 `push()` 都把整个 `HostSnapshot` 序列化后推给渲染进程。
因为只在触发点推，频率不高；但会话很多时这份 JSON 不小。

### 已知隐患：切标签的首次读取和实时事件有竞态

`App.tsx` 里切标签时 `getTabEntries` 是异步的。如果这期间来了实时事件
（后台标签正在流式输出），`applySessionEvents` 会往 `items[tabId]` 里追加 ——
但那个 key 可能还不存在，它会从空数组开始追加。

等 `getTabEntries` 返回时，`setItems` 是**整个覆盖**，会把那几条实时事件冲掉。

**这条尚未验证**。验证方法和结论记在本文末尾。

---

## 五、一张图

```
                    ┌─────────────────────────────────────┐
Pi 事件 ──────────► │                                     │
（自己 runtime）    │   HostState（主进程权威）            │
                    │                                     │
用户操作 ─────────► │  refreshConversations()  重读磁盘    │──► snapshot 事件
（开/关/切/重载）   │  readSession()           读 runtime  │    （整份替换）
                    │  checkStale()            比 mtime    │
窗口焦点 ─────────► │                                     │──► session 事件
（离开 ≥ 3 秒）     └─────────────────────────────────────┘    （增量 16ms 批）
                                          │
磁盘 jsonl ◄──────────────────────────────┘（读）

                    ┌─────────────────────────────────────┐
Pi 事件 ──────────► │  渲染进程 store                      │
（实时流）          │  items[tabId] 增量套用               │
                    │  streaming[tabId]                    │
切标签 ───────────► │  getTabEntries 只在没有缓存时读      │
（首次）            └─────────────────────────────────────┘
```

---

## 六、排查方法

**界面没更新**：

1. 先分清是哪一份状态 —— 侧栏列表/标签栏 → 快照；对话内容 → 内容流
2. 快照不更新 → 看是不是**别的进程**写的（这时只有窗口焦点能触发重读）
3. 内容流不更新 → 看标签是不是 `stale`（这时要手动重新加载）

**内容对不上**：

1. 标签是不是 `stale` —— 是的话先重新加载
2. 切标签后内容回退了 —— 可能是第六节那个竞态

**性能**：

`refreshConversations` 的耗时跟项目数和会话数成正比。如果觉得切窗口卡，
先看项目清单里选了几个项目。
