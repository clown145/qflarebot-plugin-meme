/**
 * 表情生成与补参数。
 *
 * 一次生成的开销：每张不同的图 1 次上传（服务端自己去下载）+ 1 次生成 + QQ 发图。
 * Worker 不下载、不编码图片，CPU 只花在拼 JSON 上。
 */
import type { OutgoingMessage, PluginContext, SendResult, Session } from '@qqbot/sdk'
import { withReason, type MemeApi } from './api.js'
import { parseArgs, splitArgs } from './args.js'
import type { Meme } from './catalog.js'
import type { Config, Settings } from './config.js'
import { imagesFromMessage, senderImage } from './images.js'
import type { ShortcutFill } from './match.js'
import { claimWait, dropWait, saveWait, updateWait, type MemeState, type Stored } from './sessions.js'

export interface Env {
  session: Session
  ctx: PluginContext<Config>
  settings: Settings
  api: MemeApi
}

export function respond(session: Session, message: OutgoingMessage): Promise<SendResult> {
  return session.canReply ? session.reply(message) : session.send(message)
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 发一张 meme 服务上的图：把地址直接交给 QQ 去拉。
 * QQ 拉不到（地址不是公网、证书不对）时这一步会同步失败，这里告诉用户原因，免得静默没反应。
 */
export async function sendImage(env: Env, imageId: string, text?: string): Promise<boolean> {
  const url = env.api.imageUrl(imageId)
  const result = await respond(env.session, text ? { text, image: { url } } : { image: { url } })
  if (result.ok) return true
  env.ctx.logger.warn('QQ 没有拉到 meme 服务的图片', { url, status: result.status, error: result.error })
  await respond(env.session, `图片发送失败：${result.error ?? `HTTP ${result.status}`}（QQ 要能访问 meme 服务地址）`)
  return false
}

/** 同一个地址只上传一次（比如两处都是发送者头像） */
export function uploadAll(api: MemeApi, urls: string[]): Promise<string[]> {
  const seen = new Map<string, Promise<string>>()
  return Promise.all(
    urls.map((url) => {
      let p = seen.get(url)
      if (!p) {
        p = api.upload(url)
        seen.set(url, p)
      }
      return p
    }),
  )
}

/** 从这条消息拼出第一次的参数；选项写错时抛 ArgError */
export function buildState(session: Session, settings: Settings, meme: Meme, rest: string, shortcut?: ShortcutFill): MemeState {
  const [minImages] = meme.params
  const images = imagesFromMessage(session)
  if (settings.useSenderAvatar && images.length < minImages) {
    const me = senderImage(session)
    if (me) images.unshift(me)
  }
  // 快捷指令捕获的名字（「满脑子都是张三」里的张三）按顺序给图片当名字；AstrBot 版把它丢了
  shortcut?.names.forEach((name, i) => {
    const image = images[i]
    if (image) image.name = name
  })
  const parsed = parseArgs(splitArgs(rest), meme.options)
  let texts = [...(shortcut?.texts ?? []), ...parsed.texts]
  if (!texts.length && meme.defaultTexts?.length) texts = [...meme.defaultTexts]
  return {
    kind: 'meme',
    key: meme.key,
    params: meme.params,
    texts,
    images,
    options: { ...shortcut?.options, ...parsed.options },
  }
}

export function missing(state: MemeState): { images: number; texts: number } {
  const [minImages, , minTexts] = state.params
  return {
    images: Math.max(0, minImages - state.images.length),
    texts: Math.max(0, minTexts - state.texts.length),
  }
}

/** 与上游一致：第一次提示说「需要 N 段文字」，补了一部分之后说「还差 N 段文字」 */
function describeMissing(m: { images: number; texts: number }, lead: '需要' | '还差'): string {
  const parts: string[] = []
  if (m.texts > 0) parts.push(`${lead} ${m.texts} 段文字`)
  if (m.images > 0) parts.push(`${lead} ${m.images} 张图片`)
  return parts.join('、')
}

export async function generate(api: MemeApi, state: MemeState): Promise<string> {
  const [, maxImages, , maxTexts] = state.params
  const images = state.images.slice(0, maxImages)
  const ids = await uploadAll(
    api,
    images.map((i) => i.url),
  )
  return api.generate(
    state.key,
    images.map((image, i) => ({ name: image.name, id: ids[i]! })),
    state.texts.slice(0, maxTexts),
    state.options,
  )
}

async function produce(env: Env, state: MemeState): Promise<void> {
  let imageId: string
  try {
    imageId = await generate(env.api, state)
  } catch (e) {
    env.ctx.logger.warn('表情生成失败', { key: state.key, error: errorText(e) })
    await respond(env.session, withReason('制作表情的最后一步失败了，呜呜...', e))
    return
  }
  await sendImage(env, imageId)
}

/**
 * 第一次触发：参数够就直接做；不够就开一个等待会话，关了交互式就直接提示。
 * `previous` 是这个人之前挂着的会话：这次直接做完了，旧的补参数会话要作废，
 * 否则他的下一条消息还会被当成给旧表情补的参数。
 */
export async function startMeme(env: Env, state: MemeState, key: string | null, previous: Stored | null): Promise<void> {
  const miss = missing(state)
  if (!miss.images && !miss.texts) {
    if (key && previous?.state.kind === 'meme') await dropWait(env.ctx.db, key)
    await produce(env, state)
    return
  }
  if (!key) {
    await respond(env.session, `参数不足：${describeMissing(miss, '需要')}。（提示：可在后台配置中开启交互功能）`)
    return
  }
  const seconds = Math.round(env.settings.interactiveTimeoutMs / 1000)
  const prefix = env.settings.prefixes[0] ?? ''
  await saveWait(env.ctx.db, key, state, Date.now() + env.settings.interactiveTimeoutMs)
  await respond(
    env.session,
    `参数不足，请继续发送${describeMissing(miss, '需要')}。${seconds}秒内无操作将自动取消。\n（可发送“${prefix}取消”来随时终止）`,
  )
}

/**
 * 补参数：缺文字就收这条消息的文字，缺图就收它的图片和 @ 的头像；
 * 这条消息给的不是缺的东西就不理它，返回 false。每次补上都会重新计时。
 */
export async function continueMeme(env: Env, key: string, stored: Stored & { state: MemeState }, text: string): Promise<boolean> {
  const { state } = stored
  const miss = missing(state)
  const images = miss.images > 0 ? imagesFromMessage(env.session) : []
  const words = miss.texts > 0 ? text.split(/\s+/).filter(Boolean) : []
  if (!words.length && !images.length) return false

  const next: MemeState = {
    ...state,
    texts: words.length ? [...state.texts, ...words] : state.texts,
    images: images.length ? [...state.images, ...images] : state.images,
  }
  const left = missing(next)
  const db = env.ctx.db
  if (left.images || left.texts) {
    // 更新失败说明同一个人另一条消息刚改过，让给那一条
    if (await updateWait(db, key, stored.version, next, Date.now() + env.settings.interactiveTimeoutMs)) {
      await respond(env.session, `${describeMissing(left, '还差')}。`)
    }
    return true
  }
  if (await claimWait(db, key, stored.version)) await produce(env, next)
  return true
}
