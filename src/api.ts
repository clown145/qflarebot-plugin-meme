/**
 * meme-generator-rs 的 HTTP 接口，只包了本插件用到的几个。
 *
 * 能不经过 Worker 的图就不经过：上传默认用 `{ type: 'url' }` 让服务端自己去下载，
 * 生成结果只拿 image_id，拼成 `/image/<id>` 的地址直接交给 QQ 去拉。
 * meme 服务访问不了外网、或者要令牌才能访问时（ModelScope 创空间两样都是），才由 Worker 中转。
 */
import type { Settings, UploadMode } from './config.js'

export interface RawParserFlags {
  short?: boolean
  long?: boolean
  short_aliases?: string[]
  long_aliases?: string[]
}

export interface RawOption {
  type: 'boolean' | 'string' | 'integer' | 'float'
  name: string
  default?: unknown
  description?: string | null
  choices?: string[] | null
  minimum?: number | null
  maximum?: number | null
  parser_flags?: RawParserFlags
}

export interface RawShortcut {
  pattern: string
  humanized?: string | null
  names?: string[]
  texts?: string[]
  options?: Record<string, unknown>
}

export interface RawMemeInfo {
  key: string
  params: {
    min_images: number
    max_images: number
    min_texts: number
    max_texts: number
    default_texts?: string[]
    options?: RawOption[]
  }
  keywords?: string[]
  shortcuts?: RawShortcut[]
  tags?: string[]
  date_created?: string
  date_modified?: string
}

export interface ImageInfo {
  width: number
  height: number
  is_multi_frame: boolean
  frame_count?: number | null
  average_duration?: number | null
}

/** 生成表情时的一张图：name 会被部分表情画进图里（问问、我朋友说、小天使……） */
export interface MemeImage {
  name: string
  id: string
}

/** 服务端出错时回 HTTP 500 + `{ code, message, data }`，code 的含义见 describeError */
export class MemeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'MemeApiError'
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 图片的公开转发路由：运行时把插件路由挂在 `/p/<插件名>/` 下，改插件名时这里要一起改 */
export const IMAGE_ROUTE = '/image/:id'
const IMAGE_ROUTE_MOUNT = '/p/meme/image/'

/** meme 服务的图片 id 是内容的 md5（32 位小写十六进制）；公开路由只放行这种形状，免得被当成开放代理 */
export const IMAGE_ID = /^[0-9a-f]{32}$/

export interface MemeApiOptions {
  /** 不带 `Bearer ` 的令牌；空串不鉴权 */
  token?: string
  /** 配了令牌时 QQ 拉不到 meme 服务的图，改从这个 origin 下本插件的公开路由拉 */
  publicBaseUrl?: string
  uploadMode?: UploadMode
}

/**
 * auto 模式下，meme 服务按 URL 下载失败过的服务地址（比如 ModelScope 创空间访问不了外网）。
 * 记在 isolate 内存里：之后这个实例直接走 Worker 上传，不再每张图先白试一次。
 */
const relayUploads = new Set<string>()

/** 测试用 */
export function resetUploadMemory(): void {
  relayUploads.clear()
}

/** meme 服务自己下载失败：服务端报 410（下载出错），或网关直接 5xx（服务端连接被掐断，没有错误码） */
function serverCannotFetch(e: unknown): boolean {
  return e instanceof MemeApiError && (e.code === 410 || (e.status >= 500 && e.code === undefined))
}

export class MemeApi {
  private readonly token: string
  private readonly publicBaseUrl: string
  private readonly uploadMode: UploadMode

  constructor(
    readonly baseUrl: string,
    private readonly timeoutMs: number,
    options: MemeApiOptions = {},
  ) {
    this.token = options.token ?? ''
    this.publicBaseUrl = options.publicBaseUrl ?? ''
    this.uploadMode = options.uploadMode ?? 'auto'
  }

  /**
   * 交给 QQ 去拉的图片地址。没配令牌时就是 meme 服务自己的地址；
   * 配了令牌时 QQ 带不了请求头，改走本插件的公开转发路由（没填公开地址就只能退回直链，QQ 会拉不到）。
   */
  imageUrl(id: string): string {
    if (this.token && this.publicBaseUrl) return `${this.publicBaseUrl}${IMAGE_ROUTE_MOUNT}${encodeURIComponent(id)}`
    return `${this.baseUrl}/image/${encodeURIComponent(id)}`
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {}
    if (this.token) headers.authorization = `Bearer ${this.token}`
    let payload: BodyInit | undefined
    if (body instanceof FormData) {
      payload = body
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
      throw new MemeApiError(timedOut ? 'meme 服务响应超时' : `连不上 meme 服务：${errorText(e)}`, 0)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let parsed: { code?: number; message?: string; data?: unknown; error?: { message?: string } } | undefined
      try {
        parsed = JSON.parse(text) as typeof parsed
      } catch {
        parsed = undefined
      }
      // meme 服务自己的错误是 { code, message, data }；ModelScope 这类网关是 { error: { message } }
      const message = parsed?.message || parsed?.error?.message || text.slice(0, 200) || `HTTP ${res.status}`
      throw new MemeApiError(message, res.status, parsed?.code, parsed?.data)
    }
    return res
  }

  /** 公开转发路由用：带着令牌取图，调用方把 body 原样流给 QQ */
  image(id: string): Promise<Response> {
    return this.request('GET', `/image/${encodeURIComponent(id)}`)
  }

  private async json<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    return (await (await this.request(method, path, body)).json()) as T
  }

  private async imageId(method: 'GET' | 'POST', path: string, body?: unknown): Promise<string> {
    const data = await this.json<{ image_id?: string }>(method, path, body)
    if (!data?.image_id) throw new MemeApiError('meme 服务没有返回图片', 200)
    return data.image_id
  }

  async version(): Promise<string> {
    return (await (await this.request('GET', '/meme/version')).text()).trim()
  }

  infos(): Promise<RawMemeInfo[]> {
    return this.json('GET', '/meme/infos')
  }

  info(key: string): Promise<RawMemeInfo> {
    return this.json('GET', `/memes/${encodeURIComponent(key)}/info`)
  }

  search(query: string): Promise<string[]> {
    return this.json('GET', `/meme/search?query=${encodeURIComponent(query)}&include_tags=true`)
  }

  /**
   * 上传一张图，返回 image_id。
   * url 模式让 meme 服务自己下载（Worker 不经手图片）；worker 模式由 Worker 下载后用 multipart 传过去
   * （不转 base64，只是一次内存拷贝）；auto 先试 url，服务端下载失败就换 worker 并记住。
   */
  async upload(url: string): Promise<string> {
    if (this.uploadMode === 'worker' || (this.uploadMode === 'auto' && relayUploads.has(this.baseUrl))) {
      return this.relayUpload(url)
    }
    try {
      return await this.imageId('POST', '/image/upload', { type: 'url', url })
    } catch (e) {
      if (this.uploadMode !== 'auto' || !serverCannotFetch(e)) throw e
      relayUploads.add(this.baseUrl)
      return this.relayUpload(url)
    }
  }

  private async relayUpload(url: string): Promise<string> {
    let res: Response
    try {
      res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(this.timeoutMs) })
    } catch (e) {
      throw new MemeApiError(`下载图片失败：${errorText(e)}`, 0, 410)
    }
    if (!res.ok) throw new MemeApiError(`下载图片失败：HTTP ${res.status}`, res.status, 410)
    const form = new FormData()
    form.append('file', await res.blob(), 'image')
    return this.imageId('POST', '/image/upload/multipart', form)
  }

  generate(key: string, images: MemeImage[], texts: string[], options: Record<string, unknown>): Promise<string> {
    return this.imageId('POST', `/memes/${encodeURIComponent(key)}`, { images, texts, options })
  }

  preview(key: string): Promise<string> {
    return this.imageId('GET', `/memes/${encodeURIComponent(key)}/preview`)
  }

  /** 只传要标「新」的表情，其余属性服务端有默认值 */
  renderList(properties: Record<string, { new: boolean }>): Promise<string> {
    return this.imageId('POST', '/tools/render_list', { meme_properties: properties })
  }

  inspect(imageId: string): Promise<ImageInfo> {
    return this.json('POST', '/tools/image_operations/inspect', { image_id: imageId })
  }

  operate(operation: string, body: Record<string, unknown>): Promise<string> {
    return this.imageId('POST', `/tools/image_operations/${operation}`, body)
  }

  async gifSplit(imageId: string): Promise<string[]> {
    const data = await this.json<{ image_ids?: string[] }>('POST', '/tools/image_operations/gif_split', { image_id: imageId })
    return data.image_ids ?? []
  }
}

export function createApi(settings: Settings): MemeApi {
  return new MemeApi(settings.baseUrl, settings.timeoutMs, {
    token: settings.token,
    publicBaseUrl: settings.publicBaseUrl,
    uploadMode: settings.uploadMode,
  })
}

function range(min: unknown, max: unknown): string {
  return min === max ? String(min) : `${min} ~ ${max}`
}

/**
 * 上游的失败文案原样保留；是 meme 服务报的错时，把原因补在后面的括号里。
 */
export function withReason(base: string, e: unknown): string {
  return e instanceof MemeApiError ? `${base}（${describeError(e)}）` : base
}

/** 把服务端的错误码翻成给用户看的话；不是服务端的错误就用 fallback */
export function describeError(e: unknown, fallback = '出错了，稍后再试'): string {
  if (!(e instanceof MemeApiError)) return fallback
  const d = (e.data && typeof e.data === 'object' ? e.data : {}) as Record<string, unknown>
  switch (e.code) {
    case 410:
      return '下载图片失败了，换一张试试'
    case 420:
      return '图片已过期，请重新发送'
    case 510:
      return '图片解码失败，换一张试试'
    case 520:
      return '图片编码失败了'
    case 530:
      return 'meme 服务缺少素材文件'
    case 540:
      return `参数有误：${String(d.error ?? e.message)}`
    case 550:
      return `图片数量不对：需要 ${range(d.min, d.max)} 张，实际 ${String(d.actual)} 张`
    case 551:
      return `文字数量不对：需要 ${range(d.min, d.max)} 段，实际 ${String(d.actual)} 段`
    case 560:
      return `文字太长了：${String(d.text ?? '')}`
    case 570:
      return String(d.feedback ?? e.message)
  }
  if (e.status === 401 || e.status === 403) {
    return `meme 服务拒绝访问（HTTP ${e.status}：${e.message}），需要鉴权的部署请在插件配置里填「访问令牌」`
  }
  if (e.status === 404) return 'meme 服务上没有这个表情，可以让管理员发送「刷新表情」'
  return e.message
}
