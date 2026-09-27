/**
 * 图片工具：翻转、旋转、缩放、裁剪、拼接、GIF 分解/合成/倒放/变速，全部交给 meme 服务做。
 *
 * 参数格式先校验再上传，写错了不花子请求；裁剪和变速只有真用得上原图尺寸、帧间隔时才去 inspect
 * （AstrBot 版每次都先 inspect 一次）。
 */
import { describeError, MemeApiError, type ImageInfo } from './api.js'
import { ArgError } from './args.js'
import { imagesFromMessage, senderImage } from './images.js'
import { respond, sendImage, uploadAll, type Env } from './meme.js'

export interface ToolSpec {
  name: string
  aliases?: string[]
  description: string
  usage?: string
  op: string
  /** 至少几张图 */
  min: number
  /** 用上消息里所有的图（拼接、合成）；否则只取前 min 张 */
  all?: boolean
}

export const TOOLS: ToolSpec[] = [
  { name: '水平翻转', description: '图片左右翻转', op: 'flip_horizontal', min: 1 },
  { name: '竖直翻转', description: '图片上下翻转', op: 'flip_vertical', min: 1 },
  { name: '旋转', description: '旋转图片，默认 90 度', usage: '/旋转 [角度]', op: 'rotate', min: 1 },
  { name: '缩放', description: '按尺寸缩放图片', usage: '/缩放 <宽x高|宽x|x高>', op: 'resize', min: 1 },
  { name: '裁剪', description: '裁剪图片', usage: '/裁剪 <左,上,右,下|宽x高|宽:高>', op: 'crop', min: 1 },
  { name: '灰度', aliases: ['灰度图'], description: '转成灰度图', op: 'grayscale', min: 1 },
  { name: '反色', aliases: ['反相'], description: '图片反色', op: 'invert', min: 1 },
  { name: '水平拼接', aliases: ['横向拼接'], description: '多张图左右拼接', op: 'merge_horizontal', min: 2, all: true },
  { name: '竖直拼接', aliases: ['纵向拼接'], description: '多张图上下拼接', op: 'merge_vertical', min: 2, all: true },
  { name: 'gif分解', description: '把 GIF 拆成单帧', op: 'gif_split', min: 1 },
  { name: 'gif合成', description: '多张图合成 GIF', usage: '/gif合成 [帧间隔秒]', op: 'gif_merge', min: 2, all: true },
  { name: 'gif倒放', description: 'GIF 倒着播放', op: 'gif_reverse', min: 1 },
  { name: 'gif变速', description: '调整 GIF 播放速度', usage: '/gif变速 <0.5x|50%|20fps|0.05s>', op: 'gif_change_duration', min: 1 },
]

/** 被动回复一条消息最多 5 条，GIF 分解的帧多了只发前几帧 */
const MAX_REPLIES = 5

function toNumber(text: string, what: string): number {
  const n = Number(text)
  if (text.trim() === '' || !Number.isFinite(n)) throw new ArgError(`${what}需要是数字`)
  return n
}

export function parseResize(text: string): { width: number | null; height: number | null } {
  const m = /^(\d{1,4})?[*xX, ](\d{1,4})?$/.exec(text)
  if (!m) throw new ArgError('缩放尺寸格式不正确，请使用如: 100x200, 100x, x200')
  return { width: m[1] ? Number(m[1]) : null, height: m[2] ? Number(m[2]) : null }
}

const CROP_BOX = /^(\d{1,4})[, ](\d{1,4})[, ](\d{1,4})[, ](\d{1,4})$/
const CROP_SIZE = /^(\d{1,4})[*xX, ](\d{1,4})$/
const CROP_RATIO = /^(\d{1,2})[:：比](\d{1,2})$/

export interface CropBox {
  left: number
  top: number
  right: number
  bottom: number
}

/** 返回 null 表示要原图尺寸（居中裁一个尺寸或比例）；格式不对直接抛错 */
export function parseCropBox(text: string): CropBox | null {
  const m = CROP_BOX.exec(text)
  if (m) return { left: Number(m[1]), top: Number(m[2]), right: Number(m[3]), bottom: Number(m[4]) }
  if (CROP_SIZE.test(text) || CROP_RATIO.test(text)) return null
  throw new ArgError('裁剪格式不正确，请使用如: 0,0,100,100 或 100x100 或 16:9')
}

export function centeredCrop(text: string, info: Pick<ImageInfo, 'width' | 'height'>): CropBox {
  let width: number
  let height: number
  const size = CROP_SIZE.exec(text)
  const ratio = CROP_RATIO.exec(text)
  if (size) {
    width = Number(size[1])
    height = Number(size[2])
  } else if (ratio) {
    const wp = Number(ratio[1])
    const hp = Number(ratio[2])
    if (!wp || !hp) throw new ArgError('比例不能为 0')
    const scale = Math.min(info.width / wp, info.height / hp)
    width = Math.trunc(wp * scale)
    height = Math.trunc(hp * scale)
  } else {
    throw new ArgError('裁剪格式不正确，请使用如: 0,0,100,100 或 100x100 或 16:9')
  }
  const left = Math.floor((info.width - width) / 2)
  const top = Math.floor((info.height - height) / 2)
  return { left, top, right: left + width, bottom: top + height }
}

const P_FLOAT = String.raw`\d{0,3}\.?\d{1,3}`
const FPS = new RegExp(`^(${P_FLOAT})fps$`, 'i')
const SECONDS = new RegExp(`^(${P_FLOAT})(m?)s$`, 'i')
const TIMES = new RegExp(`^(${P_FLOAT})(?:x|X|倍速?)$`)
const PERCENT = new RegExp(`^(${P_FLOAT})%$`)

function checkDuration(duration: number): number {
  if (!Number.isFinite(duration) || duration < 0.02) {
    throw new ArgError(`帧间隔必须大于 0.02s (50fps)，当前为 ${Number.isFinite(duration) ? duration.toFixed(3) : '∞'}s`)
  }
  return duration
}

/** 直接给了帧率或时长就返回帧间隔；按倍速、百分比时返回 null，要原图的平均帧间隔 */
export function absoluteDuration(text: string): number | null {
  let m = FPS.exec(text)
  if (m) return checkDuration(1 / Number(m[1]))
  m = SECONDS.exec(text)
  if (m) return checkDuration(m[2] ? Number(m[1]) / 1000 : Number(m[1]))
  if (TIMES.test(text) || PERCENT.test(text)) return null
  throw new ArgError('变速格式不正确，请使用如: 0.5x, 50%, 20fps, 0.05s')
}

export function relativeDuration(text: string, info: Pick<ImageInfo, 'average_duration'>): number {
  const base = info.average_duration || 0.1
  let m = TIMES.exec(text)
  if (m) return checkDuration(base / Number(m[1]))
  m = PERCENT.exec(text)
  if (m) return checkDuration(base / (Number(m[1]) / 100))
  throw new ArgError('变速格式不正确，请使用如: 0.5x, 50%, 20fps, 0.05s')
}

export async function runTool(env: Env, tool: ToolSpec, argText: string): Promise<void> {
  const { session, api } = env
  const text = argText.trim()
  try {
    // 先校验参数，写错了不必上传
    let degrees = 90
    let resize: ReturnType<typeof parseResize> | undefined
    let crop: CropBox | null | undefined
    let duration: number | null = null
    if (tool.op === 'rotate' && text) degrees = toNumber(text, '旋转角度')
    if (tool.op === 'resize') resize = parseResize(text)
    if (tool.op === 'crop') crop = parseCropBox(text)
    if (tool.op === 'gif_merge') duration = text ? toNumber(text, '帧间隔') : 0.1
    if (tool.op === 'gif_change_duration') duration = absoluteDuration(text)

    const images = imagesFromMessage(session)
    if (images.length < tool.min && env.settings.useSenderAvatar) {
      const me = senderImage(session)
      if (me) images.unshift(me)
    }
    if (images.length < tool.min) throw new ArgError(`图片数量不足，此操作需要 ${tool.min} 张图片。`)
    const used = tool.all ? images : images.slice(0, tool.min)
    const ids = await uploadAll(
      api,
      used.map((i) => i.url),
    )
    const image_id = ids[0]!

    if (tool.op === 'gif_split') {
      const frames = await api.gifSplit(image_id)
      if (!frames.length) {
        await respond(session, '图片处理失败，未收到结果。')
        return
      }
      // QQ 官方机器人没有合并转发，一张图就是一条消息，多了只能发前几张
      const shown = frames.length <= MAX_REPLIES ? frames : frames.slice(0, MAX_REPLIES - 1)
      if (shown.length < frames.length) {
        await respond(session, `处理完成，共生成 ${frames.length} 张图片：\n（QQ 一次最多回复 ${MAX_REPLIES} 条，只发前 ${shown.length} 张）`)
      }
      for (const frame of shown) if (!(await sendImage(env, frame))) break
      return
    }

    let result: string
    switch (tool.op) {
      case 'rotate':
        result = await api.operate('rotate', { image_id, degrees })
        break
      case 'resize':
        result = await api.operate('resize', { image_id, ...resize })
        break
      case 'crop': {
        const box = crop ?? centeredCrop(text, await api.inspect(image_id))
        result = await api.operate('crop', { image_id, ...box })
        break
      }
      case 'merge_horizontal':
      case 'merge_vertical':
        result = await api.operate(tool.op, { image_ids: ids })
        break
      case 'gif_merge':
        result = await api.operate('gif_merge', { image_ids: ids, duration })
        break
      case 'gif_change_duration':
        result = await api.operate('gif_change_duration', {
          image_id,
          duration: duration ?? relativeDuration(text, await api.inspect(image_id)),
        })
        break
      default:
        result = await api.operate(tool.op, { image_id })
    }
    await sendImage(env, result)
  } catch (e) {
    // 与上游一致：参数和服务端的错误说「操作失败」，其他意外说「图片操作失败」
    if (e instanceof ArgError) {
      await respond(session, `操作失败: ${e.message}`)
      return
    }
    const message = e instanceof Error ? e.message : String(e)
    env.ctx.logger.warn('图片工具失败', { op: tool.op, error: message })
    await respond(session, e instanceof MemeApiError ? `操作失败: ${describeError(e)}` : `图片操作失败: ${message}`)
  }
}
