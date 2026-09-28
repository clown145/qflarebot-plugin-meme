import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizePlugin, qqAvatar } from '@qqbot/sdk'
import { createMockContext, createMockSession, runCommand, type MockSessionOptions } from '@qqbot/sdk/testing'
import { resetUploadMemory, type RawMemeInfo } from './api.js'
import { resetCatalogCache } from './catalog.js'
import { configSchema, type Config } from './config.js'
import plugin from './index.js'
import { createTestDB, type TestDB } from './testing.js'

const BASE = 'https://meme.test'
const CONFIG: Partial<Config> = { base_url: BASE }

const INFOS: RawMemeInfo[] = [
  {
    key: 'ask',
    params: {
      min_images: 1,
      max_images: 1,
      min_texts: 0,
      max_texts: 1,
      options: [
        {
          type: 'string',
          name: 'gender',
          default: 'unknown',
          description: '性别',
          choices: ['male', 'female', 'unknown'],
          parser_flags: { short: true, long: true, short_aliases: [], long_aliases: [] },
        },
      ],
    },
    keywords: ['问问'],
    tags: ['日常'],
    date_created: new Date().toISOString(),
  },
  {
    key: 'petpet',
    params: {
      min_images: 1,
      max_images: 1,
      min_texts: 0,
      max_texts: 0,
      options: [
        {
          type: 'boolean',
          name: 'circle',
          default: false,
          parser_flags: { short: true, long: true, short_aliases: ['圆'], long_aliases: [] },
        },
      ],
    },
    keywords: ['摸', '摸摸'],
    date_created: '2022-01-01T00:00:00+08:00',
  },
  {
    key: 'crawl',
    params: {
      min_images: 1,
      max_images: 1,
      min_texts: 0,
      max_texts: 0,
      options: [
        {
          type: 'integer',
          name: 'number',
          minimum: 1,
          maximum: 92,
          parser_flags: { short: true, long: true, short_aliases: [], long_aliases: [] },
        },
      ],
    },
    keywords: ['爬'],
  },
  { key: 'kiss', params: { min_images: 2, max_images: 2, min_texts: 0, max_texts: 0 }, keywords: ['亲'] },
  {
    key: 'fill_head',
    params: { min_images: 1, max_images: 1, min_texts: 0, max_texts: 0 },
    keywords: ['满脑子'],
    shortcuts: [{ pattern: '满脑子都是(?P<name>\\S+)', names: ['{name}'], humanized: '满脑子都是xx' }],
  },
  { key: 'high_eq', params: { min_images: 0, max_images: 0, min_texts: 2, max_texts: 2 }, keywords: ['高情商'] },
  {
    key: 'my_friend_say',
    params: { min_images: 1, max_images: 1, min_texts: 1, max_texts: 10, default_texts: ['让我康康'] },
    keywords: ['我朋友说'],
  },
  { key: 'doraemon_say', params: { min_images: 0, max_images: 0, min_texts: 1, max_texts: 1 }, keywords: ['哆啦A梦说'] },
]

interface Call {
  method: string
  path: string
  body?: Record<string, unknown>
  /** 请求带的 Authorization 头 */
  auth?: string
}

let calls: Call[]
/** Worker 自己去下载的外部地址（worker 上传模式） */
let downloads: string[]
let db: TestDB
let searchResult: string[]
let frames: number
/** 模拟访问不了外网的部署（ModelScope 创空间）：按 URL 上传时网关直接 503 */
let serverOffline: boolean
/** 模拟要令牌的部署：不带这个令牌一律 401 */
let requiredToken: string

beforeEach(async () => {
  resetCatalogCache()
  resetUploadMemory()
  calls = []
  downloads = []
  searchResult = []
  frames = 3
  serverOffline = false
  requiredToken = ''
  db = await createTestDB()
  let uploads = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.origin !== BASE) {
        downloads.push(url.href)
        return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } })
      }
      const auth = new Headers(init?.headers).get('authorization') ?? undefined
      const raw = init?.body
      const body =
        raw instanceof FormData
          ? { multipart: [...raw.keys()] }
          : raw
            ? (JSON.parse(String(raw)) as Record<string, unknown>)
            : undefined
      calls.push({ method: init?.method ?? 'GET', path: url.pathname + url.search, ...(body ? { body } : {}), ...(auth ? { auth } : {}) })
      if (requiredToken && auth !== `Bearer ${requiredToken}`) {
        return Response.json({ error: { message: 'Authentication failed, please make sure that a valid ModelScope token is supplied.' } }, { status: 401 })
      }
      const p = url.pathname
      if (p === '/meme/version') return new Response('0.2.0')
      if (p === '/meme/infos') return Response.json(INFOS)
      if (p === '/meme/search') return Response.json(searchResult)
      if (p === '/image/upload') {
        if (serverOffline) return new Response('upstream connect error or disconnect/reset before headers.', { status: 503 })
        return Response.json({ image_id: `up${++uploads}` })
      }
      if (p === '/image/upload/multipart') return Response.json({ image_id: `mp${++uploads}` })
      if (p.startsWith('/image/')) return new Response(new Uint8Array([71, 73, 70]), { headers: { 'content-type': 'image/gif' } })
      if (p.endsWith('/info')) return Response.json(INFOS.find((i) => p === `/memes/${i.key}/info`))
      if (p.endsWith('/preview')) return Response.json({ image_id: 'preview' })
      if (p.startsWith('/memes/')) return Response.json({ image_id: 'result' })
      if (p === '/tools/render_list') return Response.json({ image_id: 'list' })
      if (p === '/tools/image_operations/inspect') return Response.json({ width: 300, height: 200, is_multi_frame: false })
      if (p === '/tools/image_operations/gif_split') {
        return Response.json({ image_ids: Array.from({ length: frames }, (_, i) => `frame${i}`) })
      }
      if (p.startsWith('/tools/image_operations/')) return Response.json({ image_id: 'tool' })
      return new Response('Meme not found', { status: 404 })
    }),
  )
  await plugin.hooks!.onInstall!(createMockContext(plugin, { config: CONFIG as Config, db }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const catchAll = normalizePlugin(plugin).regex[0]!.handler

/** 走兜底规则发一条消息（等价于没被别的命令接走） */
async function say(content: string, options: MockSessionOptions = {}, config: Partial<Config> = CONFIG) {
  const session = createMockSession({ content, ...options })
  const ctx = createMockContext(plugin, { config: config as Config, db })
  await catchAll({ session, ctx, match: [content] as unknown as RegExpMatchArray })
  return session
}

/** 群全量消息：没 @ 机器人 */
const plain: MockSessionOptions = { atMe: false, event: 'qq.group.message', rawType: 'GROUP_MESSAGE_CREATE' }

function generated(key: string) {
  return calls.filter((c) => c.path === `/memes/${key}`).map((c) => c.body as { images: Array<{ name: string; id: string }>; texts: string[]; options: Record<string, unknown> })
}

function uploadedUrls() {
  return calls.filter((c) => c.path === '/image/upload').map((c) => (c.body as { url: string }).url)
}

function waitingRows() {
  return db.raw<{ k: string }>('SELECT k FROM p_meme_sessions')
}

describe('图片带上真实名字（AstrBot 版写死成 img0）', () => {
  it('@ 的人用对方昵称，头像交给 meme 服务按 URL 下载', async () => {
    const session = await say('/问问', { mentions: [{ id: 'OPENID_A', username: '张三', bot: false }] })
    expect(generated('ask')[0]!.images).toEqual([{ name: '张三', id: 'up1' }])
    expect(uploadedUrls()).toEqual([qqAvatar('test-bot', 'OPENID_A', 640)])
    expect(session.replies).toEqual([{ image: { url: `${BASE}/image/result` } }])
  })

  it('用发送者头像时名字是发送者昵称；发的图片没有名字', async () => {
    await say('/问问', { userName: '李四' })
    await say('/问问', { attachments: [{ url: 'https://multimedia.nt.qq.com.cn/x', contentType: 'image/png' }] })
    expect(generated('ask').map((g) => g.images[0]!.name)).toEqual(['李四', ''])
  })

  it('快捷指令捕获的名字画进图里', async () => {
    await say('/满脑子都是王五')
    expect(generated('fill_head')[0]!.images[0]!.name).toBe('王五')
  })

  it('被 @ 的机器人不算图片来源', async () => {
    await say('/问问', { mentions: [{ id: 'BOT', username: '机器人', bot: true }], userName: '赵六' })
    expect(generated('ask')[0]!.images[0]!.name).toBe('赵六')
  })

  describe('没开全量消息的群：被 @ 的群友只在正文里', () => {
    const BOT_MEMBER = '0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F'
    const TARGET = 'A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1'

    it('mentions 一项都没有：认正文里关键词后面的 <@…>，前面那个当作在叫机器人', async () => {
      await say('/问问', { userName: '赵六', raw: { content: `<@${BOT_MEMBER}> /问问 <@${TARGET}>` } })
      expect(uploadedUrls()).toEqual([qqAvatar('test-bot', TARGET, 640)])
    })

    it('mentions 里只有 @ 机器人那一项（is_you）', async () => {
      await say('/问问', {
        userName: '赵六',
        raw: { content: `<@${BOT_MEMBER}> /问问 <@${TARGET}>`, mentions: [{ id: BOT_MEMBER, username: '机器人', is_you: true }] },
      })
      expect(uploadedUrls()).toEqual([qqAvatar('test-bot', TARGET, 640)])
    })

    it('原始 mentions 是 member_openid / nickname 的写法也认，名字画进图里', async () => {
      await say('/问问', {
        raw: {
          content: `<@${BOT_MEMBER}> /问问 <@${TARGET}>`,
          mentions: [
            { member_openid: BOT_MEMBER, nickname: '机器人', is_you: true },
            { member_openid: TARGET, nickname: '小明', is_you: false },
          ],
        },
      })
      expect(generated('ask')[0]!.images[0]!.name).toBe('小明')
    })

    it('只 @ 了机器人：用发送者自己的头像，不会拿机器人的', async () => {
      await say('/问问', { userName: '赵六', raw: { content: `<@${BOT_MEMBER}> /问问` } })
      expect(generated('ask')[0]!.images[0]!.name).toBe('赵六')
    })
  })
})

describe('选项', () => {
  it('每次只带这次写的选项，不会串到后面的请求（AstrBot 版的可变默认参数）', async () => {
    await say('/摸 -圆')
    await say('/爬 --number 3')
    await say('/摸')
    await say('/爬')
    expect(generated('petpet').map((g) => g.options)).toEqual([{ circle: true }, {}])
    expect(generated('crawl').map((g) => g.options)).toEqual([{ number: 3 }, {}])
  })

  it('选项写错时提示，不去生成', async () => {
    const session = await say('/爬 -n 很多')
    expect(session.replies[0]).toBe('开启表情制作任务失败了...（参数解析或类型转换错误: -n 需要一个整数，收到「很多」）')
    expect(generated('crawl')).toHaveLength(0)
  })

  it('没给文字时用表情的默认文字', async () => {
    await say('/我朋友说')
    expect(generated('my_friend_say')[0]!.texts).toEqual(['让我康康'])
  })
})

describe('触发条件', () => {
  it('群里没 @ 也没前缀的消息不加载目录、不请求 meme 服务', async () => {
    const session = await say('摸', plain)
    expect(calls).toEqual([])
    expect(session.replies).toEqual([])
  })

  it('开了不带前缀也触发后，首词是关键词就做', async () => {
    await say('摸', plain, { ...CONFIG, bare_keywords: true })
    expect(generated('petpet')).toHaveLength(1)
  })

  it('@ 机器人时只认首词，带前缀才做模糊匹配', async () => {
    await say('摸鱼去了')
    expect(generated('petpet')).toHaveLength(0)
    await say('/摸摸头')
    expect(generated('petpet')).toHaveLength(1)
  })

  it('目录只拉一次：D1 里一行，后续消息用内存缓存', async () => {
    await say('/摸')
    await say('/问问')
    expect(calls.filter((c) => c.path === '/meme/infos')).toHaveLength(1)
    expect(db.raw('SELECT k FROM p_meme_catalog')).toHaveLength(1)

    // 换一个 isolate（内存缓存清空）：从 D1 读，不再请求 /meme/infos
    resetCatalogCache()
    await say('/摸')
    expect(calls.filter((c) => c.path === '/meme/infos')).toHaveLength(1)
  })

  it('没配 meme 服务地址时命令给出提示', async () => {
    const session = await runCommand(plugin, '表情列表', '', { ctx: { db } })
    expect(session.replies[0]).toContain('还没有配置')
  })
})

describe('补参数（D1 会话）', () => {
  it('图片不够时等下一条消息，补齐就做，做完删掉会话', async () => {
    const first = await say('/亲', { userName: '我' })
    expect(first.replies).toEqual(['参数不足，请继续发送需要 1 张图片。60秒内无操作将自动取消。\n（可发送“/取消”来随时终止）'])
    expect(waitingRows()).toHaveLength(1)

    const second = await say('', { ...plain, mentions: [{ id: 'OPENID_B', username: '对象', bot: false }] })
    expect(generated('kiss')[0]!.images.map((i) => i.name)).toEqual(['我', '对象'])
    expect(second.replies).toEqual([{ image: { url: `${BASE}/image/result` } }])
    expect(waitingRows()).toHaveLength(0)
  })

  it('文字分几次补：先提示还差多少，补齐后按顺序生成', async () => {
    await say('/高情商')
    const partial = await say('你好', plain)
    expect(partial.replies).toEqual(['还差 1 段文字。'])
    await say('再见', plain)
    expect(generated('high_eq')[0]!.texts).toEqual(['你好', '再见'])
    expect(waitingRows()).toHaveLength(0)
  })

  it('一次交互只写 2～3 行：开会话、补一次、收尾', async () => {
    await say('/摸') // 先把目录载入（写目录那一行不算在交互里）
    const before = db.rowsWritten
    await say('/高情商')
    await say('一', plain)
    await say('二', plain)
    expect(db.rowsWritten - before).toBe(3)
  })

  it('没有等待会话时，普通消息只多一次主键读、零写入', async () => {
    const reads = db.reads
    const writes = db.rowsWritten
    await say('今天天气不错', plain)
    expect(db.reads - reads).toBe(1)
    expect(db.rowsWritten - writes).toBe(0)
  })

  it('给的不是缺的东西就不理，会话留着', async () => {
    await say('/亲')
    const session = await say('哈哈', plain)
    expect(session.replies).toEqual([])
    expect(waitingRows()).toHaveLength(1)
  })

  it('发送「取消」终止', async () => {
    await say('/亲')
    const session = await say('取消', plain)
    expect(session.replies).toEqual(['操作已取消。'])
    expect(waitingRows()).toHaveLength(0)
  })

  it('另一个表情直接做完时，旧的等待作废', async () => {
    await say('/亲')
    await say('/摸')
    expect(waitingRows()).toHaveLength(0)
    await say('', { ...plain, mentions: [{ id: 'OPENID_B', username: '对象', bot: false }] })
    expect(generated('kiss')).toHaveLength(0)
  })

  it('不同的人、不同的群互不影响', async () => {
    await say('/亲', { userId: 'u1' })
    const other = await say('', { ...plain, userId: 'u2', mentions: [{ id: 'OPENID_B', username: '对象', bot: false }] })
    expect(other.replies).toEqual([])
    expect(generated('kiss')).toHaveLength(0)
  })

  it('超时后不再续接；每天的定时任务把超时的行删掉', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-26T00:00:00Z'))
    await say('/亲')
    vi.setSystemTime(new Date('2026-09-26T00:01:01Z'))
    const late = await say('', { ...plain, mentions: [{ id: 'OPENID_B', username: '对象', bot: false }] })
    expect(late.replies).toEqual([])
    expect(waitingRows()).toHaveLength(1)

    const cron = normalizePlugin(plugin).cron[0]!
    await cron.handler({ ctx: createMockContext(plugin, { config: CONFIG as Config, db }), job: cron.name, scheduledAt: Date.now() })
    expect(waitingRows()).toHaveLength(0)
  })

  it('关掉交互式：直接提示参数不足，完全不读写会话表', async () => {
    const config = { ...CONFIG, interactive: false }
    await say('/摸', {}, config) // 先把目录载入
    const reads = db.reads
    const session = await say('/亲', { userName: '我' }, config)
    expect(session.replies).toEqual(['参数不足：需要 1 张图片。（提示：可在后台配置中开启交互功能）'])
    await say('哈哈', plain, config)
    expect(db.reads).toBe(reads)
    expect(waitingRows()).toHaveLength(0)
  })
})

describe('命令', () => {
  const ctx = () => ({ config: CONFIG as Config, db })

  it('表情搜索：多页时开翻页会话，< > 和页码都能翻', async () => {
    searchResult = Array.from({ length: 10 }, () => 'petpet')
    const first = await runCommand(plugin, '表情搜索', '摸', { ctx: ctx() })
    expect(first.replies[0]).toContain('页码 1/2')
    const next = await say('>', plain)
    expect(next.replies[0]).toContain('9. petpet')
    expect(next.replies[0]).toContain('页码 2/2')
    const back = await say('1', plain)
    expect(back.replies[0]).toContain('页码 1/2')
    expect(back.replies[0]).toContain("发送 '<' 或 '>' 翻页，或直接发送页码。超时30秒后自动结束。")
    // 与上游一致：发了别的就结束这次搜索
    expect((await say('随便聊聊', plain)).replies).toEqual(['搜索会话已结束。'])
    expect(waitingRows()).toHaveLength(0)
  })

  it('表情搜索：只有一页就不写会话', async () => {
    searchResult = ['petpet', 'ask']
    const session = await runCommand(plugin, '表情搜索', '摸', { ctx: ctx() })
    expect(session.replies[0]).toContain('2. ask (问问)\n    tags: 日常')
    expect(waitingRows()).toHaveLength(0)
  })

  it('表情详情：显示可选值与默认值，附预览图', async () => {
    const session = await runCommand(plugin, '表情详情', '问问', { ctx: ctx() })
    const reply = session.replies[0] as { text: string; image: { url: string } }
    expect(reply.text).toContain('--gender/-g <STRING>')
    expect(reply.text).toContain('可选: male, female, unknown | 默认: unknown')
    expect(reply.image.url).toBe(`${BASE}/image/preview`)
  })

  it('表情列表：只给最近创建的标「新」', async () => {
    const session = await runCommand(plugin, '表情列表', '', { ctx: ctx() })
    expect(calls.find((c) => c.path === '/tools/render_list')!.body).toEqual({ meme_properties: { ask: { new: true } } })
    expect(session.replies[0]).toEqual({
      text: '触发：“/关键词 [文] [@人] [--选项]”\n/表情详情 <关键词> | /表情搜索 <关键词>\n',
      image: { url: `${BASE}/image/list` },
    })
  })

  it('随机表情：什么都不给时挑不要图、只要一段文字的', async () => {
    await runCommand(plugin, '随机表情', '', { ctx: ctx() })
    expect(generated('doraemon_say')).toEqual([{ images: [], texts: ['请输入文本'], options: {} }])
  })

  it('随机表情：按给的图片数、文字数挑', async () => {
    await runCommand(plugin, '随机表情', '', { ctx: ctx(), session: { attachments: [{ url: 'https://img/1', contentType: 'image/png' }] } })
    const made = calls.filter((c) => c.path.startsWith('/memes/')).map((c) => c.path.slice('/memes/'.length))
    expect(made).toHaveLength(1)
    expect(['ask', 'petpet', 'crawl', 'fill_head']).toContain(made[0])
  })

  it('刷新表情只给 Bot 管理员，并重新拉目录', async () => {
    expect(normalizePlugin(plugin).commands.find((c) => c.name === '刷新表情')!.permission).toBe('bot_admin')
    const session = await runCommand(plugin, '刷新表情', '', { ctx: ctx() })
    expect(session.replies[0]).toBe('表情包列表刷新成功！共加载 8 个表情和 1 个快捷指令。')
  })

  it('QQ 拉不到图时告诉用户原因', async () => {
    const session = createMockSession({ content: '/摸' })
    const seen: unknown[] = []
    session.reply = async (m) => {
      seen.push(m)
      return seen.length === 1 ? { ok: false, status: 400, error: '富媒体上传失败', raw: null } : { ok: true, status: 200, raw: null }
    }
    await catchAll({ session, ctx: createMockContext(plugin, { config: CONFIG as Config, db }), match: ['/摸'] as unknown as RegExpMatchArray })
    expect(seen[0]).toEqual({ image: { url: `${BASE}/image/result` } })
    expect(seen[1]).toContain('图片发送失败：富媒体上传失败')
  })
})

describe('访问令牌与上传方式（ModelScope 创空间这类部署）', () => {
  const TOKEN = 'ms-test-token'
  const withToken: Partial<Config> = { ...CONFIG, token: TOKEN, public_base_url: 'https://bot.example.com/随手粘的路径' }

  it('填了令牌后，发往 meme 服务的请求都带 Authorization: Bearer', async () => {
    requiredToken = TOKEN
    await say('/摸', {}, withToken)
    expect(generated('petpet')).toHaveLength(1)
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true)
  })

  it('令牌前面多粘了 Bearer 也认', async () => {
    requiredToken = TOKEN
    await say('/摸', {}, { ...withToken, token: `Bearer ${TOKEN}` })
    expect(generated('petpet')).toHaveLength(1)
  })

  it('没填令牌时不带请求头；服务要鉴权时提示去填令牌', async () => {
    requiredToken = TOKEN
    const session = await runCommand(plugin, '表情列表', '', { ctx: { config: CONFIG as Config, db } })
    expect(calls[0]!.auth).toBeUndefined()
    expect(session.replies[0]).toContain('meme 服务拒绝访问（HTTP 401：Authentication failed')
    expect(session.replies[0]).toContain('「访问令牌」')
  })

  it('配了令牌时，交给 QQ 的是本插件的转发地址', async () => {
    requiredToken = TOKEN
    const session = await say('/摸', {}, withToken)
    expect(session.replies).toEqual([{ image: { url: 'https://bot.example.com/p/meme/image/result' } }])
  })

  it('转发路由带着令牌取图并原样流给 QQ；id 不合法或没配令牌时 404', async () => {
    requiredToken = TOKEN
    const route = plugin.routes![0]!
    const id = '6c825ed7ea4cd25657288ab4f7d0227f'
    const request = (p: string) => new Request(`https://bot.example.com/p/meme/image/${p}`)
    const ctx = createMockContext(plugin, { config: withToken as Config, db })

    const ok = await route.handler({ ctx, request: request(id), params: { id }, authenticated: false })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/gif')
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array([71, 73, 70]))
    expect(calls.at(-1)).toMatchObject({ path: `/image/${id}`, auth: `Bearer ${TOKEN}` })

    const bad = await route.handler({ ctx, request: request('x'), params: { id: '../meme/infos' }, authenticated: false })
    expect(bad.status).toBe(404)
    const noToken = createMockContext(plugin, { config: CONFIG as Config, db })
    expect((await route.handler({ ctx: noToken, request: request(id), params: { id }, authenticated: false })).status).toBe(404)
  })

  it('配了令牌却没填公开地址：QQ 拉不到时提示去填', async () => {
    requiredToken = TOKEN
    const session = createMockSession({ content: '/摸' })
    const seen: unknown[] = []
    session.reply = async (m) => {
      seen.push(m)
      return seen.length === 1 ? { ok: false, status: 400, error: '富媒体上传失败', raw: null } : { ok: true, status: 200, raw: null }
    }
    const ctx = createMockContext(plugin, { config: { ...CONFIG, token: TOKEN } as Config, db })
    await catchAll({ session, ctx, match: ['/摸'] as unknown as RegExpMatchArray })
    expect(seen[0]).toEqual({ image: { url: `${BASE}/image/result` } })
    expect(seen[1]).toContain('请在插件配置里填「机器人公开地址」')
  })

  it('插件配置没填公开地址时用机器人的（ctx.publicUrl）；填了的优先', async () => {
    requiredToken = TOKEN
    const reply = async (config: Partial<Config>) => {
      const session = createMockSession({ content: '/摸' })
      const ctx = createMockContext(plugin, { config: config as Config, db, publicUrl: 'https://bot.qflare.test' })
      await catchAll({ session, ctx, match: ['/摸'] as unknown as RegExpMatchArray })
      return session.replies
    }
    expect(await reply({ ...CONFIG, token: TOKEN })).toEqual([{ image: { url: 'https://bot.qflare.test/p/meme/image/result' } }])
    expect(await reply(withToken)).toEqual([{ image: { url: 'https://bot.example.com/p/meme/image/result' } }])
  })

  it('令牌是 writeOnly：面板不回显', () => {
    expect((configSchema.properties as Record<string, { writeOnly?: boolean }>).token!.writeOnly).toBe(true)
  })

  it('auto：meme 服务按 URL 下载失败时改由 Worker 下载、multipart 上传，这个实例之后直接走 Worker', async () => {
    serverOffline = true
    await say('/问问', { mentions: [{ id: 'OPENID_A', username: '张三', bot: false }] })
    expect(generated('ask')[0]!.images).toEqual([{ name: '张三', id: 'mp1' }])
    expect(downloads).toEqual([qqAvatar('test-bot', 'OPENID_A', 640)])
    expect(calls.find((c) => c.path === '/image/upload/multipart')!.body).toEqual({ multipart: ['file'] })

    const urlTries = () => calls.filter((c) => c.path === '/image/upload').length
    expect(urlTries()).toBe(1)
    await say('/问问', { mentions: [{ id: 'OPENID_B', username: '李四', bot: false }] })
    expect(urlTries()).toBe(1)
    expect(generated('ask')).toHaveLength(2)
  })

  it('url 模式失败不回退；worker 模式直接由 Worker 上传', async () => {
    serverOffline = true
    const failed = await say('/摸', {}, { ...CONFIG, upload_mode: 'url' })
    expect(failed.replies[0]).toContain('制作表情的最后一步失败了，呜呜...（upstream connect error')
    expect(downloads).toEqual([])

    await say('/摸', {}, { ...CONFIG, upload_mode: 'worker' })
    expect(calls.filter((c) => c.path === '/image/upload')).toHaveLength(1)
    expect(generated('petpet')).toHaveLength(1)
  })
})

describe('图片工具', () => {
  const ctx = () => ({ config: CONFIG as Config, db })
  const image = { attachments: [{ url: 'https://multimedia.nt.qq.com.cn/a', contentType: 'image/gif' }] }

  it('旋转默认 90 度', async () => {
    const session = await runCommand(plugin, '旋转', '', { ctx: ctx(), session: image })
    expect(calls.find((c) => c.path.endsWith('/rotate'))!.body).toEqual({ image_id: 'up1', degrees: 90 })
    expect(session.replies).toEqual([{ image: { url: `${BASE}/image/tool` } }])
  })

  it('裁剪给坐标时不 inspect，给比例时才 inspect', async () => {
    await runCommand(plugin, '裁剪', '0,0,10,10', { ctx: ctx(), session: image })
    expect(calls.some((c) => c.path.endsWith('/inspect'))).toBe(false)
    await runCommand(plugin, '裁剪', '1:1', { ctx: ctx(), session: image })
    expect(calls.filter((c) => c.path.endsWith('/crop')).map((c) => c.body)).toEqual([
      { image_id: 'up1', left: 0, top: 0, right: 10, bottom: 10 },
      { image_id: 'up2', left: 50, top: 0, right: 250, bottom: 200 },
    ])
  })

  it('参数写错时不上传', async () => {
    const session = await runCommand(plugin, '缩放', '大一点', { ctx: ctx(), session: image })
    expect(session.replies).toEqual(['操作失败: 缩放尺寸格式不正确，请使用如: 100x200, 100x, x200'])
    expect(uploadedUrls()).toEqual([])
  })

  it('图不够时与上游同样提示', async () => {
    const session = await runCommand(plugin, '水平拼接', '', { ctx: { config: { ...CONFIG, use_sender_when_no_image: false } as Config, db } })
    expect(session.replies).toEqual(['操作失败: 图片数量不足，此操作需要 2 张图片。'])
  })

  it('拼接用上所有图，图不够时补发送者头像', async () => {
    await runCommand(plugin, '水平拼接', '', {
      ctx: ctx(),
      session: {
        attachments: [
          { url: 'https://img/1', contentType: 'image/png' },
          { url: 'https://img/2', contentType: 'image/png' },
          { url: 'https://img/3', contentType: 'image/png' },
        ],
      },
    })
    expect(calls.find((c) => c.path.endsWith('/merge_horizontal'))!.body).toEqual({ image_ids: ['up1', 'up2', 'up3'] })
    await runCommand(plugin, '竖直拼接', '', { ctx: ctx(), session: image })
    expect(uploadedUrls().slice(3)).toEqual([qqAvatar('test-bot', 'mock-user', 640), 'https://multimedia.nt.qq.com.cn/a'])
  })

  it('GIF 分解：不超过 5 帧全发，多了只发前 4 帧', async () => {
    const few = await runCommand(plugin, 'gif分解', '', { ctx: ctx(), session: image })
    expect(few.replies).toHaveLength(3)
    frames = 12
    const many = await runCommand(plugin, 'gif分解', '', { ctx: ctx(), session: image })
    expect(many.replies[0]).toBe('处理完成，共生成 12 张图片：\n（QQ 一次最多回复 5 条，只发前 4 张）')
    expect(many.replies).toHaveLength(5)
  })
})

describe('表不会越存越多', () => {
  it('目录只有一行，重复刷新是覆盖', async () => {
    await runCommand(plugin, '刷新表情', '', { ctx: { config: CONFIG as Config, db } })
    await runCommand(plugin, '刷新表情', '', { ctx: { config: CONFIG as Config, db } })
    expect(db.raw('SELECT k FROM p_meme_catalog')).toHaveLength(1)
  })

  it('同一个人反复开会话只有一行', async () => {
    await say('/亲')
    await say('/高情商')
    await say('/亲')
    expect(waitingRows()).toHaveLength(1)
  })
})
