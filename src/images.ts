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

/** @ 的人按在消息里出现的先后排序；机器人（包括被 @ 的本机器人）不算 */
function orderedMentions(session: Session): Mention[] {
  const people = session.mentions.filter((m) => m.id && !m.bot)
  if (people.length < 2) return people
  const raw = session.raw as { content?: unknown } | undefined
  const content = typeof raw?.content === 'string' ? raw.content : ''
  const position = (m: Mention) => {
    const i = content.indexOf(m.id)
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }
  return [...people].sort((a, b) => position(a) - position(b))
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
