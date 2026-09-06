import axios from 'axios'
import type { Session } from 'electron'
import { Readable } from 'node:stream'

/** 隔离页面通过 Node HTTPS 读取资源，绕开 Chromium 网络连接兼容问题；保留 TLS 验证。 */
export function useNodeTransport(target: Session, signal: AbortSignal, onJson: (url: string, body: unknown) => void): () => void {
  target.protocol.handle('https', async request => {
    try {
      if (/\/aweme\/v1\/web\/aweme\/detail\//.test(new URL(request.url).pathname)) {
        try {
          const native = await target.fetch(request, {bypassCustomProtocolHandlers: true, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])})
          if (native.ok) {
            const body = await native.clone().json().catch(() => null)
            if (body) onJson(request.url, body)
          }
          return native
        } catch {
          // 原生网络连接失败时继续用 Node HTTPS；之前这里错误地再次调用原生网络。
          signal.throwIfAborted()
        }
      }
      const headers = Object.fromEntries(request.headers.entries())
      const cookies = await target.cookies.get({url: request.url})
      if (cookies.length) headers.cookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
      const response = await axios.request({url: request.url, method: request.method, headers,
        data: ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.from(await request.arrayBuffer()),
        responseType: 'stream', maxRedirects: 0, validateStatus: () => true, timeout: 15_000, signal})
      // 自定义协议不会替代浏览器维护会话，按原站 Set-Cookie 同步到隔离会话。
      for (const rawCookie of response.headers['set-cookie'] ?? []) {
        const [pair, ...attributes] = rawCookie.split(';')
        const separator = pair.indexOf('=')
        if (separator < 1) continue
        const values = new Map(attributes.map(part => {const at = part.indexOf('='); return [part.slice(0, at < 0 ? undefined : at).trim().toLowerCase(), at < 0 ? '' : part.slice(at + 1).trim()] }))
        const domain = values.get('domain')
        const host = new URL(request.url).hostname
        if (domain && host !== domain.replace(/^\./, '') && !host.endsWith(`.${domain.replace(/^\./, '')}`)) continue
        const expiry = values.has('max-age') ? Date.now() / 1000 + Number(values.get('max-age')) : Date.parse(values.get('expires') ?? '') / 1000
        await target.cookies.set({url: request.url, name: pair.slice(0, separator), value: pair.slice(separator + 1),
          ...(domain ? {domain} : {}), path: values.get('path') || '/', secure: values.has('secure'), httpOnly: values.has('httponly'),
          ...(Number.isFinite(expiry) ? {expirationDate: expiry} : {})}).catch(() => undefined)
      }
      const outgoing = new Headers()
      for (const [name, value] of Object.entries(response.headers)) {
        if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name.toLowerCase()) || value == null) continue
        for (const entry of Array.isArray(value) ? value : [String(value)]) outgoing.append(name, entry)
      }
      if (response.status === 204 || response.status === 304 || request.method === 'HEAD') {
        response.data.destroy()
        return new Response(null, {status: response.status, headers: outgoing})
      }
      if (/\/aweme\/(?:v\d+\/)?(?:web\/)?(?:multi\/)?(?:aweme\/)?(?:detail|iteminfo)\//.test(new URL(request.url).pathname) && response.status === 200) {
        const chunks: Buffer[] = []; let size = 0
        for await (const chunk of response.data) {
          size += chunk.length
          if (size > 8 * 1024 * 1024) throw new Error('作品详情响应过大')
          chunks.push(chunk)
        }
        const body = Buffer.concat(chunks)
        try { onJson(request.url, JSON.parse(body.toString('utf8'))) } catch { /* 非 JSON 仍交给页面 */ }
        return new Response(body, {status: response.status, headers: outgoing})
      }
      return new Response(Readable.toWeb(response.data) as ReadableStream<Uint8Array>, {status: response.status, headers: outgoing})
    } catch {
      if (!signal.aborted && ['GET', 'HEAD'].includes(request.method)) {
        try { return await target.fetch(request, {bypassCustomProtocolHandlers: true, signal}) } catch { /* 两种正常网络路径均失败 */ }
      }
      return new Response(null, {status: 502})
    }
  })
  return () => target.protocol.unhandle('https')
}
