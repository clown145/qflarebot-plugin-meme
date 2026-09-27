import type { Session } from '@qqbot/sdk'
import type { Catalog, Meme } from './catalog.js'
import type { Settings } from './config.js'

export interface Addressed {
  /** 去掉前缀后的正文 */
  text: string
  /** 是不是靠前缀叫的：只有带了前缀才做模糊匹配，@ 机器人随口聊天不至于被当成关键词 */
  prefixed: boolean
}

export function stripPrefix(content: string, prefixes: string[]): { text: string; prefixed: boolean } {
  const trimmed = content.trim()
  for (const p of prefixes) {
    if (trimmed.startsWith(p)) return { text: trimmed.slice(p.length).trim(), prefixed: true }
  }
  return { text: trimmed, prefixed: false }
}

/**
 * 这条消息是不是在叫表情：带了前缀、@ 了机器人（单聊天然算）、或开了「不带前缀也触发」。
 * 都不是就返回 null，调用方不用加载目录。
 */
export function addressedText(session: Session, settings: Settings): Addressed | null {
  const { text, prefixed } = stripPrefix(session.content, settings.prefixes)
  if (prefixed || session.atMe || settings.bareKeywords) return { text, prefixed }
  return null
}

export interface ShortcutFill {
  names: string[]
  texts: string[]
  options: Record<string, unknown>
}

export interface MemeHit {
  meme: Meme
  /** 关键词之后的原文；快捷指令命中时为空 */
  rest: string
  shortcut?: ShortcutFill
}

/** 快捷指令里的 `{name}` 占位换成捕获组；没有这个组就换成空串 */
function fill(template: string, groups: Record<string, string | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => groups[name] ?? '')
}

/**
 * 顺序与 AstrBot 版一致：先整句匹配快捷指令，再看首词是不是关键词，最后（允许时）按最长前缀模糊匹配。
 * 关键词不分大小写（AstrBot 版分，「哆啦a梦说」「Steam消息」都触发不了）。
 */
export function matchMeme(catalog: Catalog, text: string, fuzzy: boolean): MemeHit | null {
  if (!text) return null
  for (const { shortcut, meme, re } of catalog.shortcutRules) {
    const m = re.exec(text)
    if (!m) continue
    const groups = m.groups ?? {}
    const options: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(shortcut.options ?? {})) options[k] = typeof v === 'string' ? fill(v, groups) : v
    return {
      meme,
      rest: '',
      shortcut: {
        names: (shortcut.names ?? []).map((n) => fill(n, groups)),
        texts: (shortcut.texts ?? []).map((t) => fill(t, groups)),
        options,
      },
    }
  }

  const lower = text.toLowerCase()
  const first = lower.split(/\s/, 1)[0] ?? ''
  const exact = catalog.byKeyword.get(first)
  if (exact) return { meme: exact, rest: text.slice(first.length).trim() }
  if (!fuzzy) return null
  for (const kw of catalog.keywordsByLength) {
    if (lower.startsWith(kw)) return { meme: catalog.byKeyword.get(kw)!, rest: text.slice(kw.length).trim() }
  }
  return null
}

/** 表情详情用：关键词或 key 精确查找 */
export function findMeme(catalog: Catalog, keyword: string): Meme | undefined {
  return catalog.byKeyword.get(keyword.trim().toLowerCase())
}
