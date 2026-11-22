import { describe, expect, it } from 'vitest'
import {
  historyKeyOf,
  initialHistoryState,
  stepHistory,
  type HistoryState
} from '../host/renderer/src/conversation/inputHistory'

/**
 * 输入历史翻页的纯逻辑（GLOSSARY「输入历史」）。
 *
 * 历史按时间序排（越早越靠前）；`pointer` 为 null 表示「在最底下」，
 * 即没在翻历史，输入框里是草稿槽里的内容。
 */

const HISTORY = ['最早一句', '中间一句', '最新一句']

function up(state: HistoryState, history: readonly string[] = HISTORY): HistoryState & { text: string } {
  return stepHistory(history, state, { type: 'up' })
}

function down(state: HistoryState, history: readonly string[] = HISTORY): HistoryState & { text: string } {
  return stepHistory(history, state, { type: 'down' })
}

describe('向上翻历史', () => {
  it('第一次按上箭头回填最新一条', () => {
    const result = up(initialHistoryState())
    expect(result.text).toBe('最新一句')
    expect(result.pointer).toBe(2)
  })

  it('连续往上逐条翻，到最老一条停住，不循环', () => {
    let state = up(initialHistoryState())
    state = up(state)
    expect(state.text).toBe('中间一句')
    state = up(state)
    expect(state.text).toBe('最早一句')
    // 再按还是最老那条
    state = up(state)
    expect(state.text).toBe('最早一句')
    expect(state.pointer).toBe(0)
  })
})

describe('向下翻历史', () => {
  it('从最新一条往下越过最新，还原翻阅之前的草稿', () => {
    let state = stepHistory(HISTORY, initialHistoryState(), { type: 'edit', text: '写了一半的话' })
    state = up(state)
    expect(state.text).toBe('最新一句')
    const back = down(state)
    expect(back.text).toBe('写了一半的话')
    expect(back.pointer).toBeNull()
  })

  it('草稿原本为空就还原成空输入框', () => {
    let state = up(initialHistoryState())
    state = down(state)
    expect(state.text).toBe('')
    expect(state.pointer).toBeNull()
  })

  it('已经回到最底下再按下箭头什么也不发生', () => {
    let state = stepHistory(HISTORY, initialHistoryState(), { type: 'edit', text: '草稿' })
    const again = down(state)
    expect(again.text).toBe('草稿')
    expect(again.pointer).toBeNull()
  })
})

describe('在历史条目上编辑', () => {
  it('改过的版本进草稿槽，往下越过最新时拿到改过的那份', () => {
    let state = up(initialHistoryState())
    state = stepHistory(HISTORY, state, { type: 'edit', text: '最新一句，改了' })
    // 继续往上翻，改过的版本不丢
    state = up(state)
    expect(state.text).toBe('中间一句')
    expect(state.draft).toBe('最新一句，改了')
    // 一路往下越过最新
    state = down(state)
    expect(state.text).toBe('最新一句')
    state = down(state)
    expect(state.text).toBe('最新一句，改了')
    expect(state.pointer).toBeNull()
  })

  it('历史本身不被改写', () => {
    const history = ['原始一句']
    let state = up(initialHistoryState(), history)
    state = stepHistory(history, state, { type: 'edit', text: '改过的' })
    state = down(state)
    expect(history).toEqual(['原始一句'])
    expect(up(initialHistoryState(), history).text).toBe('原始一句')
  })
})

describe('复位', () => {
  it('复位回到最新：之后按上箭头从最新一条开始', () => {
    let state = up(initialHistoryState())
    state = up(state)
    expect(state.text).toBe('中间一句')

    /*
     * 四种复位触发点（发送成功、切 agent、切项目标签、Esc）在界面上走的是同一个
     * `reset` 意图；这里逐个用不同的复位后文本验一遍。
     */
    for (const text of ['', '切 agent 后的草稿', '切项目标签后的草稿', 'Esc 取消后的草稿']) {
      const reset = stepHistory(HISTORY, state, { type: 'reset', text })
      expect(reset.pointer).toBeNull()
      expect(reset.text).toBe(text)
      expect(reset.draft).toBe(text)
      // 复位之后按上箭头是从最新一条开始
      expect(up(reset).text).toBe('最新一句')
    }
  })
})

describe('边界', () => {
  it('历史为空时上下箭头都不动输入', () => {
    const state = stepHistory([], initialHistoryState(), { type: 'edit', text: '正在写' })
    expect(up(state, []).text).toBe('正在写')
    expect(down(state, []).text).toBe('正在写')
    expect(up(state, []).pointer).toBeNull()
  })

  it('重复的相同消息不去重，按几次才走过去', () => {
    const history = ['继续', '继续', '继续']
    let state = up(initialHistoryState(), history)
    expect(state.text).toBe('继续')
    state = up(state, history)
    expect(state.pointer).toBe(1)
    state = up(state, history)
    expect(state.pointer).toBe(0)
  })

  it('历史在翻页期间变短（切支线）时把越界指针收回最新', () => {
    let state = up(initialHistoryState(), ['a', 'b', 'c'])
    state = up(state, ['a', 'b', 'c'])
    expect(state.pointer).toBe(1)
    // 切到只有一条的支线：指针 1 越界，按上箭头应回到那一条，而不是空
    expect(up(state, ['only']).text).toBe('only')
    expect(down(state, ['only']).pointer).toBeNull()
  })
})

describe('按键归属', () => {
  const base = {
    key: 'ArrowUp',
    composing: false,
    menuOpen: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    selectionCollapsed: true,
    newlineBeforeCaret: false,
    newlineAfterCaret: false
  }

  it('普通上 / 下箭头归历史', () => {
    expect(historyKeyOf(base)).toBe('up')
    expect(historyKeyOf({ ...base, key: 'ArrowDown', newlineAfterCaret: false })).toBe('down')
  })

  it('输入法组词中不归历史', () => {
    expect(historyKeyOf({ ...base, composing: true })).toBeNull()
  })

  it('下拉菜单开着时方向键归菜单', () => {
    expect(historyKeyOf({ ...base, menuOpen: true })).toBeNull()
  })

  it('带修饰键不归历史', () => {
    for (const key of ['shiftKey', 'ctrlKey', 'metaKey', 'altKey'] as const) {
      expect(historyKeyOf({ ...base, [key]: true })).toBeNull()
    }
  })

  it('光标不在首行 / 末行时让 textarea 自己走', () => {
    expect(historyKeyOf({ ...base, newlineBeforeCaret: true })).toBeNull()
    expect(historyKeyOf({ ...base, key: 'ArrowDown', newlineAfterCaret: true })).toBeNull()
  })

  it('有选中文本时让 textarea 处理', () => {
    expect(historyKeyOf({ ...base, selectionCollapsed: false })).toBeNull()
  })

  it('别的按键不归历史', () => {
    expect(historyKeyOf({ ...base, key: 'Enter' })).toBeNull()
    expect(historyKeyOf({ ...base, key: 'ArrowLeft' })).toBeNull()
  })
})
