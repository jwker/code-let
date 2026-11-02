/**
 * 从 build/icon.svg 生成各平台的应用图标。
 *
 * 用法：npx electron scripts/gen-icon.cjs
 *
 * 产物（全在 build/ 下）：
 *   icon.png         1024×1024，Linux / electron-builder 兜底
 *   icon.icns        macOS（16–1024 全套）
 *   icon.ico         Windows（16–256 七档）
 *   icon.iconset/    中间产物，iconutil 的输入目录（用完删掉）
 *
 * 为什么要过一遍 Electron：XML 转 PNG 没有标准库能干净地做，
 * 而 Electron 本身就是个浏览器 —— 渲染 SVG 再截图，比引依赖靠谱。
 */
const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// 试过用 force-device-scale-factor 压成 1:1，Electron 45 上没生效，
// capturePage 仍然返回 2048×2048。留着这个 switch（对能生效的版本有用），
// 后面按实际尺寸判断再做下采样 —— 从 2048 缩到 1024 是超采样，
// 边缘比直接渲染 1024 更平滑，不是损失。
app.commandLine.appendSwitch('force-device-scale-factor', '1')

const ROOT = process.cwd()
const BUILD = path.join(ROOT, 'build')
const SVG = path.join(BUILD, 'icon.svg')
const MASTER = path.join(BUILD, 'icon.png')
const SMALL = path.join(BUILD, '.icon-small.png')

/** iconset 里每一档的文件名和像素尺寸（macOS 要求的就是这套组合） */
const ICONSET = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]

/** ICO 里的尺寸。256 那一档的宽高字段写 0 —— 这是 ICO 格式的规定。 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

/**
 * 用一个窗口渲染出若干张 1024×1024 的 PNG。
 *
 * 为什么复用同一个窗口：早先每张图新建一个 BrowserWindow，第一张好了、第二张
 * 必然 ERR_FAILED —— 第一个窗口 destroy 之后 app 已经进入「没有窗口」的状态，
 * 渲染进程起不来了。同一个窗口连着 loadURL 就没这个问题。
 *
 * @param jobs [{ svg: string, out: string }]
 */
async function renderAll(jobs) {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
  })

  for (const { svg, out } of jobs) {
    // SVG 直接内联进 HTML，再走 data URL —— 没有中间文件，也就没有
    // 「写入后立刻读取」那种竞态。
    const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
  svg { display: block; width: 1024px; height: 1024px; }
</style></head>
<body>${svg}</body></html>`

    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    // 渐变和圆角要等一帧才画完
    await new Promise((r) => setTimeout(r, 600))

    const img = await win.webContents.capturePage()
    const { width, height } = img.getSize()

    let resized = img
    if (width !== 1024) {
      resized = img.resize({ width: 1024, height: 1024, quality: 'best' })
      console.log(`  ${path.basename(out)}  截图 ${width}×${height} → 下采样到 1024`)
    } else {
      console.log(`  ${path.basename(out)}  截图 ${width}×${height}`)
    }

    fs.writeFileSync(out, resized.toPNG())
    console.log(`  ${path.basename(out)}  1024×1024  ${(fs.statSync(out).size / 1024).toFixed(1)} KB`)
  }

  win.destroy()
}

/**
 * 小尺寸特调版的 SVG。
 *
 * 主图缩到 16px 之后，C 的笔画只剩 1.44px、方块 1.88px —— 全都糊在一起。
 * 所以 16px 单独一份：笔画 92 → 130，方块 120 → 132。这不是等比缩放，
 * 是把「在 16px 下还看得出是个 C 加一个光标」当成唯一目标重新调的。
 */
function makeSmallSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2A2A27"/><stop offset="1" stop-color="#141413"/>
    </linearGradient>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185.4" fill="url(#bg)"/>
  <path d="M644 354 A206 206 0 1 0 644 670" stroke="#FFFFFF" stroke-width="130" fill="none" stroke-linecap="round"/>
  <rect x="612" y="446" width="132" height="132" rx="26" fill="#FFFFFF"/>
</svg>`
}

function shrink(src, size, dst) {
  execFileSync('sips', ['-z', String(size), String(size), src, '--out', dst], {
    stdio: 'ignore',
  })
}

function makeIcns() {
  // 目录名必须以 .iconset 结尾 —— 这是 iconutil 的隐藏要求，
  // 不然后果是「Invalid Iconset」而看不出哪不对。
  const set = path.join(BUILD, 'icon.iconset')
  fs.rmSync(set, { recursive: true, force: true })
  fs.mkdirSync(set, { recursive: true })

  for (const [name, size] of ICONSET) {
    // 16pt 这两档用特调版，其余用主图
    const src = size <= 32 ? SMALL : MASTER
    shrink(src, size, path.join(set, name))
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(BUILD, 'icon.icns')])
  fs.rmSync(set, { recursive: true, force: true })

  console.log(`  icon.icns ${ICONSET.length} 档  ${(fs.statSync(path.join(BUILD, 'icon.icns')).size / 1024).toFixed(1)} KB`)
}

/**
 * 手写 ICO：6 字节头 + 每张 16 字节目录项 + 各张 PNG 原样拼接。
 * ICO 从 Vista 起就允许条目里直接放 PNG，不用写 BMP。
 */
function makeIco() {
  const tmp = path.join(BUILD, '.ico')
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })

  const entries = []
  for (const size of ICO_SIZES) {
    const p = path.join(tmp, `${size}.png`)
    shrink(MASTER, size, p)
    entries.push({ size, buf: fs.readFileSync(p) })
  }

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = 图标
  header.writeUInt16LE(entries.length, 4)

  let offset = 6 + 16 * entries.length
  const dirs = []
  for (const { size, buf } of entries) {
    const d = Buffer.alloc(16)
    const dim = size >= 256 ? 0 : size // 256 写 0
    d.writeUInt8(dim, 0) // 宽
    d.writeUInt8(dim, 1) // 高
    d.writeUInt8(0, 2) // 调色板数
    d.writeUInt8(0, 3) // reserved
    d.writeUInt16LE(1, 4) // 色彩平面
    d.writeUInt16LE(32, 6) // 位深
    d.writeUInt32LE(buf.length, 8)
    d.writeUInt32LE(offset, 12)
    dirs.push(d)
    offset += buf.length
  }

  const ico = Buffer.concat([header, ...dirs, ...entries.map((e) => e.buf)])
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico)
  fs.rmSync(tmp, { recursive: true, force: true })

  console.log(`  icon.ico  ${ICO_SIZES.length} 档  ${(ico.length / 1024).toFixed(1)} KB`)
}

app
  .whenReady()
  .then(async () => {
    console.log('生成应用图标')
    await renderAll([
      { svg: fs.readFileSync(SVG, 'utf-8'), out: MASTER },
      { svg: makeSmallSvg(), out: SMALL },
    ])
    makeIcns()
    makeIco()
    fs.rmSync(SMALL, { force: true })
    console.log('完成')
  })
  .then(() => app.exit(0))
  .catch((e) => {
    console.error('失败：', e && e.message)
    app.exit(1)
  })
