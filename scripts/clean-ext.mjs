import { rmSync } from 'node:fs'

// 清掉上一次的扩展产物，避免删掉的扩展还留在 out/ext 里被 Pi 加载
rmSync('out/ext', { recursive: true, force: true })
