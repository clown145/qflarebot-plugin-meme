import { definePlugin, type Command, type CommandInput, type PluginContext, type RegexInput, type Session } from '@qqbot/sdk'
import { createApi, describeError, IMAGE_ID, IMAGE_ROUTE, MemeApiError, withReason } from './api.js'
import { ArgError, parseArgs, splitArgs } from './args.js'
import { CATALOG_DDL, checkCatalogVersion, getCatalog, refreshCatalog, type Catalog } from './catalog.js'
import { configSchema, defaultConfig, resolveSettings, type Config } from './config.js'
import { imagesFromMessage } from './images.js'
import { formatInfo } from './info.js'
import { addressedText, findMeme, matchMeme, stripPrefix } from './match.js'
import { buildState, continueMeme, respond, sendImage, startMeme, type Env } from './meme.js'
import { continueSearch, formatSearchPage, SEARCH_TIMEOUT_MS, searchLines, totalPages } from './search.js'
import {
  dropWait,
  loadWait,
  purgeExpired,
  saveWait,
  sessionKey,
  SESSIONS_DDL,
  type MemeState,
  type SearchState,
  type Stored,
} from './sessions.js'
import { runTool, TOOLS } from './tools.js'

export type { Config } from './config.js'

const NOT_CONFIGURED = '还没有配置 meme 服务地址：面板 → 插件 → 表情包 → 配置'
const DAY_MS = 86_400_000

function envOf(session: Session, ctx: PluginContext<Config>): Env | null {
  const settings = resolveSettings(ctx.config)
  if (!settings.baseUrl) return null
  return { session, ctx, settings, api: createApi(settings) }
}

/** 命令的公共外壳：没配地址先提示，处理器自己回复 */
function command(
  spec: { description: string; usage?: string; aliases?: string[]; permission?: 'bot_admin' },
  run: (env: Env, input: CommandInput<Config>) => Promise<void>,
): Command<Config> {
  return {
    ...spec,
    async handler(input) {
      const env = envOf(input.session, input.ctx)
      if (!env) return NOT_CONFIGURED
      await run(env, input)
    },
  }
}

async function catalogOrReply(env: Env): Promise<Catalog | null> {
  try {
    return await getCatalog(env.ctx.db, env.api)
  } catch (e) {
    env.ctx.logger.warn('加载表情目录失败', { error: e instanceof Error ? e.message : String(e) })
    await respond(env.session, `获取表情列表失败：${describeError(e)}`)
    return null
  }
}

/**
 * 兜底规则：别的插件（和本插件的命令）都没接走的消息才会到这里。
 *
 * 1. 开了交互式时，先按主键查一次这个人有没有等着补参数的会话（每条消息唯一的额外开销，不写入）；
 * 2. 在叫表情（带前缀 / @ 机器人 / 单聊 / 开了不带前缀）且命中关键词或快捷指令：新做一个，旧的等待作废；
 * 3. 否则把这条消息当成给等待会话的补充：补参数或翻页。
 */
async function onMessage({ session, ctx }: RegexInput<Config>): Promise<void> {
  const env = envOf(session, ctx)
  if (!env) return
  const { settings } = env
  const key = settings.interactive ? sessionKey(session) : null
  const waiting = key ? await loadWait(ctx.db, key) : null

  const addressed = addressedText(session, settings)
  if (addressed?.text) {
    let catalog: Catalog | null = null
    try {
      catalog = await getCatalog(ctx.db, env.api)
    } catch (e) {
      // 这条消息未必是冲着表情来的，服务挂了不在群里刷屏，只记日志
      ctx.logger.warn('加载表情目录失败', { error: e instanceof Error ? e.message : String(e) })
    }
    const hit = catalog && matchMeme(catalog, addressed.text, settings.fuzzyMatch && addressed.prefixed)
    if (hit) {
      let state: MemeState
      try {
        state = buildState(session, settings, hit.meme, hit.rest, hit.shortcut)
      } catch (e) {
        if (!(e instanceof ArgError)) throw e
        // 上游在这里只回「开启表情制作任务失败了...」，把参数错误的原因吞掉了
        await respond(session, `开启表情制作任务失败了...（参数解析或类型转换错误: ${e.message}）`)
        return
      }
      await startMeme(env, state, key, waiting)
      return
    }
  }

  if (!key || !waiting) return
  const text = stripPrefix(session.content, settings.prefixes).text
  if (text === '取消') {
    await dropWait(ctx.db, key)
    await respond(session, '操作已取消。')
    return
  }
  if (waiting.state.kind === 'meme') await continueMeme(env, key, waiting as Stored & { state: MemeState }, text)
  else await continueSearch(env, key, waiting as Stored & { state: SearchState }, text)
}

const toolCommands: Record<string, Command<Config>> = Object.fromEntries(
  TOOLS.map((tool) => [
    tool.name,
    command(
      {
        description: tool.description,
        ...(tool.usage ? { usage: tool.usage } : {}),
        ...(tool.aliases ? { aliases: tool.aliases } : {}),
      },
      (env, { argText }) => runTool(env, tool, argText),
    ),
  ]),
)

export default definePlugin<Config>({
  name: 'meme',
  displayName: '表情包',
  description: '表情包制作与图片工具，对接 meme-generator-rs',
  permissions: ['net', 'db'],
  configSchema,
  defaultConfig,

  commands: {
    表情列表: command({ description: '查看所有表情', aliases: ['表情包列表'] }, async (env) => {
      const catalog = await catalogOrReply(env)
      if (!catalog) return
      const properties: Record<string, { new: boolean }> = {}
      if (env.settings.labelNewDays > 0) {
        const since = Date.now() - env.settings.labelNewDays * DAY_MS
        for (const meme of catalog.memes) if (meme.created && meme.created >= since) properties[meme.key] = { new: true }
      }
      let imageId: string
      try {
        imageId = await env.api.renderList(properties)
      } catch (e) {
        await respond(env.session, withReason('生成列表图失败了，呜呜...', e))
        return
      }
      const p = env.settings.prefixes[0] ?? ''
      await sendImage(env, imageId, `触发：“${p}关键词 [文] [@人] [--选项]”\n${p}表情详情 <关键词> | ${p}表情搜索 <关键词>\n`)
    }),

    表情详情: command(
      { description: '查看表情用法和预览', usage: '/表情详情 <关键词>', aliases: ['表情详细'] },
      async (env, { argText }) => {
        const keyword = argText.trim()
        if (!keyword) {
          await respond(env.session, `请提供关键词，如：${env.settings.prefixes[0] ?? ''}表情详情 摸`)
          return
        }
        const catalog = await catalogOrReply(env)
        if (!catalog) return
        const meme = findMeme(catalog, keyword)
        if (!meme) {
          await respond(env.session, `未找到“${keyword}”相关表情。`)
          return
        }
        try {
          const [info, previewId] = await Promise.all([env.api.info(meme.key), env.api.preview(meme.key)])
          await sendImage(env, previewId, formatInfo(info))
        } catch (e) {
          await respond(env.session, withReason('获取表情详情失败了，呜呜...', e))
        }
      },
    ),

    表情搜索: command({ description: '按关键词搜索表情', usage: '/表情搜索 <关键词>' }, async (env, { argText }) => {
      const query = argText.trim()
      if (!query) {
        await respond(env.session, `请输入搜索关键词，例如：${env.settings.prefixes[0] ?? ''}表情搜索 猫`)
        return
      }
      const catalog = await catalogOrReply(env)
      if (!catalog) return
      let keys: string[]
      try {
        keys = await env.api.search(query)
      } catch (e) {
        await respond(env.session, withReason('搜索失败了，呜呜...', e))
        return
      }
      const lines = searchLines(catalog, Array.isArray(keys) ? keys : [])
      if (!lines.length) {
        await respond(env.session, '没有找到相关表情！')
        return
      }
      const state: SearchState = { kind: 'search', query, lines, page: 0 }
      const key = env.settings.interactive ? sessionKey(env.session) : null
      // 只有一页就不开会话，省一次写入
      if (key && totalPages(lines.length) > 1) await saveWait(env.ctx.db, key, state, Date.now() + SEARCH_TIMEOUT_MS)
      await respond(env.session, formatSearchPage(state, key !== null))
    }),

    随机表情: command({ description: '随机做一个表情', usage: '/随机表情 [文字/图片]' }, async (env, { argText }) => {
      const catalog = await catalogOrReply(env)
      if (!catalog) return
      // 与 AstrBot 版一致：按给的图片数、文字数挑能做的表情；什么都没给就挑只要一段文字的
      const images = imagesFromMessage(env.session).length
      let texts = parseArgs(splitArgs(argText)).texts.length
      let rest = argText
      if (!images && !texts) {
        texts = 1
        rest = '请输入文本'
      }
      const candidates = catalog.memes.filter(
        ({ params: [minI, maxI, minT, maxT] }) => minI <= images && images <= maxI && minT <= texts && texts <= maxT,
      )
      const meme = candidates[Math.floor(Math.random() * candidates.length)]
      if (!meme) {
        await respond(env.session, '找不到能制作这个素材的表情...换个试试？')
        return
      }
      let state: MemeState
      try {
        state = buildState(env.session, env.settings, meme, rest)
      } catch (e) {
        if (!(e instanceof ArgError)) throw e
        await respond(env.session, `出错了：参数解析或类型转换错误: ${e.message}`)
        return
      }
      const key = env.settings.interactive ? sessionKey(env.session) : null
      await startMeme(env, state, key, key ? await loadWait(env.ctx.db, key) : null)
    }),

    刷新表情: command({ description: '重新拉取表情列表', permission: 'bot_admin' }, async (env) => {
      try {
        const catalog = await refreshCatalog(env.ctx.db, env.api)
        await respond(
          env.session,
          `表情包列表刷新成功！共加载 ${catalog.memes.length} 个表情和 ${catalog.shortcutRules.length} 个快捷指令。`,
        )
      } catch (e) {
        env.ctx.logger.warn('刷新表情目录失败', { error: e instanceof Error ? e.message : String(e) })
        await respond(env.session, withReason('刷新失败，请查看后台日志。', e))
      }
    }),

    ...toolCommands,
  },

  // 表情关键词来自 meme 服务，没法写成静态命令：用一条最低优先级的兜底规则接住剩下的消息
  regex: [{ pattern: '[\\s\\S]*', priority: -100, handler: onMessage }],

  cron: {
    // 北京时间每天 03:23：清掉超时没人理的等待会话；meme 服务版本变了就重建目录
    maintain: {
      cron: '23 19 * * *',
      async handler({ ctx }) {
        await purgeExpired(ctx.db)
        const settings = resolveSettings(ctx.config)
        if (settings.baseUrl) await checkCatalogVersion(ctx.db, createApi(settings))
      },
    },
  },

  routes: [
    {
      // 配了访问令牌时 QQ 拉不到 meme 服务的图，由这里带着令牌取图再流式转给 QQ。
      // 公开路由（QQ 的富媒体服务器没有登录态）；只放行 meme 服务的图片 id，没配令牌时一律 404，不当开放代理
      method: 'GET',
      path: IMAGE_ROUTE,
      auth: 'public',
      async handler({ ctx, params }) {
        const id = params.id ?? ''
        const settings = resolveSettings(ctx.config)
        if (!IMAGE_ID.test(id) || !settings.baseUrl || !settings.token) return new Response('not found', { status: 404 })
        let upstream: Response
        try {
          upstream = await createApi(settings).image(id)
        } catch (e) {
          const status = e instanceof MemeApiError && e.status === 404 ? 404 : 502
          ctx.logger.warn('转发表情图片失败', { id, error: e instanceof Error ? e.message : String(e) })
          return new Response(status === 404 ? 'not found' : 'upstream error', { status })
        }
        // 不把图片读进内存，CPU 开销接近零；meme 服务的临时图 10 分钟后清掉，缓存不必更长
        return new Response(upstream.body, {
          headers: {
            'content-type': upstream.headers.get('content-type') ?? 'image/png',
            'cache-control': 'public, max-age=600',
          },
        })
      },
    },
  ],

  hooks: {
    async onInstall(ctx) {
      await ctx.db.exec(`${CATALOG_DDL}\n${SESSIONS_DDL}`)
    },
  },
})
