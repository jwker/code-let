import { net, protocol } from 'electron'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 生产环境用 app:// 加载渲染进程。
 *
 * 必须走自定义协议而不是 file://，否则相对路径、fetch、ES module 脚本都会失效。
 * 协议要在 app.ready 之前注册，否则特权拿不到。
 */
export const APP_SCHEME = 'app'
export const APP_ORIGIN = `${APP_SCHEME}://local`

export function registerSchemesAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

/** 把 rendererRoot 下的文件映射到 app:// 上 */
export function serveRenderer(rendererRoot: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '' || pathname === '/') pathname = '/index.html'

    // 归一化后必须仍在 rendererRoot 之内
    const filePath = normalize(join(rendererRoot, pathname))
    if (!filePath.startsWith(rendererRoot + sep) && filePath !== rendererRoot) {
      return new Response('forbidden', { status: 403 })
    }

    return net.fetch(pathToFileURL(filePath).toString())
  })
}
