#!/usr/bin/env node
/**
 * 打包入口（`npm run dist`）。
 *
 * 只做一件事：把最后一次提交的短 hash 通过环境变量交给 electron-builder，
 * 让产物名字带上它（`electron-builder.yml` 里的 `${env.CODELET_COMMIT}`）。
 *
 * 为什么不把 hash 直接写进 yml：那样每提交一次就得改一次配置。
 * 为什么用环境变量而不是 `--config.artifactName`：命令行里传 `$` 会被 shell
 * 吃掉一轮，而且 Windows 上引号规则还不一样。环境变量两边都稳。
 *
 * 工作区有未提交改动（只看已跟踪文件）时加 `-dirty` —— 这种包能打，
 * 但拿它去对问题得知道它不等同于任何一个提交。
 *
 * 参数原样转给 electron-builder：`npm run dist -- --mac dmg --arm64`。
 *
 * **默认不签名。** 签名（`mac.identity`）对每个文件都跑一次带 `--timestamp` 的
 * `codesign`，要向 Apple 的时间戳服务打网络往返 —— Electron 的 220 个
 * `locale.pak` 加上嵌套框架，一个架构要十几分钟。而现在的包也没公证
 * （日志里那句 `skipped macOS notarization`），签了在别人机器上照样要右键打开，
 * 本地打包没理由为它等。要出签名包就带环境变量：`CODELET_SIGN=1 npm run dist`。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 最后一次提交的短 hash；拿不到（没装 git、不在仓库里）就给 nogit */
function commitName() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], {
      cwd: root,
      encoding: 'utf8'
    }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: root,
      encoding: 'utf8'
    }).trim()
    return dirty === '' ? sha : `${sha}-dirty`
  } catch {
    return 'nogit'
  }
}

const commit = commitName()
console.log(`打包标记：${commit}`)

const sign = process.env.CODELET_SIGN === '1'
console.log(sign ? '签名：开（CODELET_SIGN=1）' : '签名：关（本地打包，要签名带 CODELET_SIGN=1）')

// 本地装的 electron-builder；`--no-install` 保证不会临时去网上抓一个别的版本
const result = spawnSync(
  'npx',
  ['--no-install', 'electron-builder', ...process.argv.slice(2)],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      CODELET_COMMIT: commit,
      // electron-builder 认这个变量：不自动找钥匙串里的证书，等于不签名
      ...(sign ? {} : { CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
    }
  }
)

process.exit(result.status ?? 1)
