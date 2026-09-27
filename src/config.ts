import type { JsonSchema } from '@qqbot/sdk'

/** 面板里保存的配置 */
export interface Config {
  /** meme-generator-rs 服务地址。Worker 和 QQ 都要能访问：需要公网域名 + 443 端口 */
  base_url: string
  /** 单次请求 meme 服务的超时（秒） */
  timeout: number
  /** 没 @ 机器人时，关键词前要带的前缀；@ 机器人或单聊时不需要 */
  prefixes: string[]
  /** 不 @、不带前缀，消息以关键词开头也触发 */
  bare_keywords: boolean
  /** 关键词后不空格也能认出来，例如「摸摸头张三」 */
  fuzzy_match: boolean
  /** 图片不够时用发送者的头像补上 */
  use_sender_when_no_image: boolean
  /** 参数不够时等用户接着发 */
  interactive: boolean
  /** 等待补参数的时长（秒） */
  interactive_timeout: number
  /** 表情列表里，创建多少天以内的表情标「新」 */
  label_new_days: number
}

export const defaultConfig: Config = {
  base_url: '',
  timeout: 15,
  prefixes: ['/'],
  bare_keywords: false,
  fuzzy_match: true,
  use_sender_when_no_image: true,
  interactive: true,
  interactive_timeout: 60,
  label_new_days: 7,
}

export const configSchema: JsonSchema = {
  type: 'object',
  properties: {
    base_url: {
      type: 'string',
      title: 'meme 服务地址',
      description: 'meme-generator-rs 的地址，如 https://meme.example.com。Worker 调它生成表情，QQ 也直接从这里拉图，所以要公网域名 + 443 端口（Workers 不能直连 IP）',
      default: '',
    },
    timeout: {
      type: 'integer',
      title: '请求超时（秒）',
      description: '整次处理跑在 waitUntil 里，总共不能超过 30 秒；生成要先上传再生成两步，所以单次别设太长',
      minimum: 1,
      maximum: 25,
      default: 15,
    },
    prefixes: {
      type: 'array',
      items: { type: 'string' },
      title: '关键词前缀',
      description: '没 @ 机器人时，关键词前要带这些前缀之一才触发；@ 机器人或单聊时不需要。建议与面板的命令前缀一致',
      default: ['/'],
    },
    bare_keywords: {
      type: 'boolean',
      title: '不带前缀也触发',
      description: '开启后，群里任何以表情关键词开头的消息都会触发（群开了接收全部消息时会很频繁）',
      default: false,
    },
    fuzzy_match: {
      type: 'boolean',
      title: '关键词模糊匹配',
      description: '关键词后面不加空格也能认出，例如「摸摸头张三」',
      default: true,
    },
    use_sender_when_no_image: {
      type: 'boolean',
      title: '图片不够时用发送者头像',
      default: true,
    },
    interactive: {
      type: 'boolean',
      title: '参数不够时等待补充',
      description: '关闭后参数不够直接提示用法。开启时，每条没被其他命令接走的消息会多一次 D1 主键读（不写入）',
      default: true,
    },
    interactive_timeout: { type: 'integer', title: '等待补充的时长（秒）', minimum: 10, maximum: 300, default: 60 },
    label_new_days: { type: 'integer', title: '「新」标记天数', minimum: 0, maximum: 365, default: 7 },
  },
  required: ['base_url'],
}

/** 配置归一化后的样子：地址去掉末尾斜杠、数字夹到合理范围 */
export interface Settings {
  baseUrl: string
  timeoutMs: number
  prefixes: string[]
  bareKeywords: boolean
  fuzzyMatch: boolean
  useSenderAvatar: boolean
  interactive: boolean
  interactiveTimeoutMs: number
  labelNewDays: number
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, n))
}

export function resolveSettings(config: Partial<Config> | undefined): Settings {
  const c = { ...defaultConfig, ...config }
  const prefixes = Array.isArray(c.prefixes) ? c.prefixes.filter((p): p is string => typeof p === 'string' && p.trim() !== '') : []
  return {
    baseUrl: typeof c.base_url === 'string' ? c.base_url.trim().replace(/\/+$/, '') : '',
    timeoutMs: clamp(c.timeout, 1, 25, defaultConfig.timeout) * 1000,
    prefixes: prefixes.map((p) => p.trim()).sort((a, b) => b.length - a.length),
    bareKeywords: c.bare_keywords === true,
    fuzzyMatch: c.fuzzy_match !== false,
    useSenderAvatar: c.use_sender_when_no_image !== false,
    interactive: c.interactive !== false,
    interactiveTimeoutMs: clamp(c.interactive_timeout, 10, 300, defaultConfig.interactive_timeout) * 1000,
    labelNewDays: clamp(c.label_new_days, 0, 365, defaultConfig.label_new_days),
  }
}
