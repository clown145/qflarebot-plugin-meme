import { qqAvatar, type Attachment, type Mention, type Session } from '@qqbot/sdk'

/**
 * 一张待用的图：url 交给 meme 服务自己下载；name 是图里要画的名字。
 *
 * AstrBot 版把 name 写死成 "img0"、"img1"，问问、我朋友说、小天使、请假条、复读、满脑子等
 * 会把名字画进图里的表情就都画成了 img0，表情自己「没名字时写他/她」的兜底也因此失效。
 * 这里按来源取名字，取不到就留空串。
 */
export interface ImageSource {
  url: string
  name: string
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i

function isImage(a: Attachment): boolean {
  const type = a.contentType?.toLowerCase()
  if (type) return type.startsWith('image')
  return !a.filename || IMAGE_EXT.test(a.filename)
}

/** 平台原始 mentions 里的一项：群消息可能是 id / username，也可能是 member_openid / nickname */
interface RawMention {
  id?: unknown
  member_openid?: unknown
  user_openid?: unknown
  nickname?: unknown
  username?: unknown
  bot?: unknown
  is_you?: unknown
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const AT = /<@!?([0-9A-Za-z_-]+)>/g

/**
 * @ 的人按在消息里出现的先后排序；机器人（包括被 @ 的本机器人）不算。
 * 1. 平台给的 mentions（原始推送两套字段都读，再并上 session.mentions），标了 bot 或 is_you 的是机器人；
 * 2. 正文里的 `<@openid>`：没开全量消息的群里「@机器人 摸 @群友」，被 @ 的群友可能只在正文里、不在 mentions 里。
 *    机器人在群里的 openid 和 AppID 不是一个，mentions 没标出来时认不出它，所以关键词前面那一串 @ 当作在叫机器人、不算
 */
function orderedMentions(session: Session): Mention[] {
  const raw = session.raw as { content?: unknown; mentions?: unknown } | undefined
  const bots = new Set<string>([session.botId])
  const people: Mention[] = []
  const add = (id: string, username: string, bot: boolean) => {
    if (!id) return
    if (bot) bots.add(id)
    else {
      const known = people.find((p) => p.id === id)
      if (!known) people.push({ id, username, bot: false })
      else if (!known.username) known.username = username
    }
  }
  for (const m of Array.isArray(raw?.mentions) ? (raw.mentions as RawMention[]) : []) {
    if (!m || typeof m !== 'object') continue
    add(str(m.member_openid) || str(m.id) || str(m.user_openid), str(m.nickname) || str(m.username), m.bot === true || m.is_you === true)
  }
  for (const m of session.mentions) add(m.id, m.username, m.bot)

  const content = str(raw?.content)
  const head = /^(?:\s*<@!?[0-9A-Za-z_-]+>)+/.exec(content)?.[0] ?? ''
  for (const m of content.slice(head.length).matchAll(AT)) add(m[1]!, '', false)

  const position = (m: Mention) => {
    const i = content.indexOf(m.id)
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }
  return people
    .filter((p) => !bots.has(p.id))
    .map((p, i) => ({ p, i }))
    .sort((a, b) => position(a.p) - position(b.p) || a.i - b.i)
    .map((x) => x.p)
}

/** 消息里带的图：先是 @ 的人的头像（名字用对方昵称），再是发的图片（没有名字） */
export function imagesFromMessage(session: Session): ImageSource[] {
  const out: ImageSource[] = []
  for (const m of orderedMentions(session)) {
    const url = qqAvatar(session.botId, m.id, 640)
    if (url) out.push({ url, name: m.username })
  }
  for (const a of session.attachments) {
    if (a.url && isImage(a)) out.push({ url: a.url, name: '' })
  }
  return out
}

/** 发送者自己的头像，名字用发送者昵称 */
export function senderImage(session: Session): ImageSource | null {
  return session.avatarUrl ? { url: session.avatarUrl, name: session.userName } : null
}
