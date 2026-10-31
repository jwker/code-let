
/**
 * 代码高亮 —— 懒加载的 Shiki 实例（PLAN.md 切片 4）。
 *
 * 两个关键选择：
 *
 * **用 `engine/javascript` 而不是 oniguruma** —— 后者要加载 WASM，
 * 而应用在生产环境走自定义的 `app://` 协议，wasm 的取回未必通。纯 JS 引擎没这个风险，
 * 代价是略慢（对预览一个文件来说感觉不到）。
 *
 * **fine-grained bundle** —— 只装用得上的语言和主题，不用 `shiki/bundle/full`
 * （那个有几 MB，而且会让首屏慢）。
 */

/** 应用里两套主题，跟 `--surface` 的亮暗对应 */
const THEME_LIGHT = 'github-light'
const THEME_DARK = 'github-dark'

/** 扩展名 → Shiki 语言 id。不在表里的就不高亮，降级成纯文本 */
const LANG_MAP: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  css: 'css',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  go: 'go',
  rs: 'rust',
  java: 'java',
  sql: 'sql',
  xml: 'xml',
  vue: 'vue'
}

/** 按文件名（或相对路径）取 Shiki 语言 id；取不到返回 null */
export function langOf(path: string): string | null {
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  return LANG_MAP[ext] ?? null
}

/** Shiki 的核心类型，只在内部用 —— 不静态 import，避免把它拉进首屏 */
type Highlighter = Awaited<ReturnType<typeof import('shiki/core').createHighlighterCore>>

let pending: Promise<Highlighter | null> | null = null

/**
 * 拿到（或第一次创建）高亮器。
 *
 * 失败返回 null —— 调用方降级成纯文本，不能因为高亮不了就显示不出内容。
 */
function getHighlighter(): Promise<Highlighter | null> {
  if (pending) return pending
  pending = (async () => {
    try {
      /*
       * **核心也要动态 import** —— 静态 import 会把它（约 337KB）拉进首屏 chunk，
       * 而高亮只在打开代码文件时才需要。这一句让整条高亮链路都进独立 chunk。
       */
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript')
      ])

      // 只装用得到的语言；动态 import 让它们跟着这个模块一起懒加载
      const langs = await Promise.all([
        import('shiki/langs/typescript.mjs'),
        import('shiki/langs/tsx.mjs'),
        import('shiki/langs/javascript.mjs'),
        import('shiki/langs/jsx.mjs'),
        import('shiki/langs/json.mjs'),
        import('shiki/langs/css.mjs'),
        import('shiki/langs/html.mjs'),
        import('shiki/langs/markdown.mjs'),
        import('shiki/langs/python.mjs'),
        import('shiki/langs/shellscript.mjs'),
        import('shiki/langs/yaml.mjs'),
        import('shiki/langs/toml.mjs'),
        import('shiki/langs/go.mjs'),
        import('shiki/langs/rust.mjs'),
        import('shiki/langs/java.mjs'),
        import('shiki/langs/sql.mjs'),
        import('shiki/langs/xml.mjs'),
        import('shiki/langs/vue.mjs')
      ])
      const themes = await Promise.all([
        import('shiki/themes/github-light.mjs'),
        import('shiki/themes/github-dark.mjs')
      ])
      return await createHighlighterCore({
        themes,
        langs,
        engine: createJavaScriptRegexEngine()
      })
    } catch {
      return null
    }
  })()
  return pending
}

/**
 * 把代码高亮成 HTML。
 *
 * - 语言不认识（或没装）→ 返回 null，调用方降级成纯文本
 * - 高亮器起不来 → 同上
 *
 * 输出的是**可信 HTML**：代码内容是 Shiki 自己转义过的，可以塞进
 * `dangerouslySetInnerHTML`。但只放它生成的这一段，不要拼接别的。
 */
export async function highlight(code: string, lang: string, theme: 'light' | 'dark'): Promise<string | null> {
  const highlighter = await getHighlighter()
  if (!highlighter) return null
  try {
    return highlighter.codeToHtml(code, {
      lang,
      theme: theme === 'dark' ? THEME_DARK : THEME_LIGHT
    })
  } catch {
    return null
  }
}
