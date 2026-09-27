/**
 * meme-generator-rs 的 HTTP 接口，只包了本插件用到的几个。
 *
 * 图片一律不经过 Worker：上传用 `{ type: 'url' }` 让服务端自己去下载，
 * 生成结果只拿 image_id，拼成 `/image/<id>` 的地址直接交给 QQ 去拉。
 */

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

export class MemeApi {
  constructor(
    readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  /** QQ 直接从这里拉图 */
  imageUrl(id: string): string {
    return `${this.baseUrl}/image/${encodeURIComponent(id)}`
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
      throw new MemeApiError(timedOut ? 'meme 服务响应超时' : `连不上 meme 服务：${errorText(e)}`, 0)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let parsed: { code?: number; message?: string; data?: unknown } | undefined
      try {
        parsed = JSON.parse(text) as typeof parsed
      } catch {
        parsed = undefined
      }
      throw new MemeApiError(parsed?.message || text.slice(0, 200) || `HTTP ${res.status}`, res.status, parsed?.code, parsed?.data)
    }
    return res
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

  upload(url: string): Promise<string> {
    return this.imageId('POST', '/image/upload', { type: 'url', url })
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
  if (e.status === 404) return 'meme 服务上没有这个表情，可以让管理员发送「刷新表情」'
  return e.message
}
