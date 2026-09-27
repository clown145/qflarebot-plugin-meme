import type { Catalog } from './catalog.js'
import { respond, type Env } from './meme.js'
import { claimWait, updateWait, type SearchState, type Stored } from './sessions.js'

export const PAGE_SIZE = 8
export const SEARCH_TIMEOUT_MS = 30_000

const PREV = new Set(['上一页', '上页', '上', '←', '<', '<-'])
const NEXT = new Set(['下一页', '下页', '下', '→', '>', '->'])

export function totalPages(count: number): number {
  return Math.max(1, Math.ceil(count / PAGE_SIZE))
}

/** 一条结果一行（带标签时两行），编号全局连续 */
export function searchLines(catalog: Catalog, keys: string[]): string[] {
  const lines: string[] = []
  for (const key of keys) {
    const meme = catalog.byKey.get(key)
    if (!meme) continue
    let line = `${lines.length + 1}. ${meme.key} (${meme.keywords.join('/')})`
    if (meme.tags?.length) line += `\n    tags: ${meme.tags.join('、')}`
    lines.push(line)
  }
  return lines
}

/** paging 为 false 时（没开交互式，翻不了页）只给第一页，提示换个更精确的词 */
export function formatSearchPage(state: SearchState, paging: boolean): string {
  const total = totalPages(state.lines.length)
  const start = state.page * PAGE_SIZE
  let msg = `找到了与“${state.query}”相关的表情：\n${state.lines.slice(start, start + PAGE_SIZE).join('\n')}`
  if (total > 1) {
    msg += paging
      ? `\n\n--- 页码 ${state.page + 1}/${total} ---\n发送 '<' 或 '>' 翻页，或直接发送页码。超时${SEARCH_TIMEOUT_MS / 1000}秒后自动结束。`
      : `\n\n--- 共 ${state.lines.length} 个，只列出前 ${PAGE_SIZE} 个，换个更精确的关键词试试 ---`
  }
  return msg
}

/** 翻页；与上游一致，发了别的就结束这次搜索 */
export async function continueSearch(env: Env, key: string, stored: Stored & { state: SearchState }, text: string): Promise<boolean> {
  const { state } = stored
  const total = totalPages(state.lines.length)
  let page: number
  if (/^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= total) page = Number(text) - 1
  else if (PREV.has(text)) page = (state.page - 1 + total) % total
  else if (NEXT.has(text)) page = (state.page + 1) % total
  else {
    if (await claimWait(env.ctx.db, key, stored.version)) await respond(env.session, '搜索会话已结束。')
    return true
  }

  const next: SearchState = { ...state, page }
  if (await updateWait(env.ctx.db, key, stored.version, next, Date.now() + SEARCH_TIMEOUT_MS)) {
    await respond(env.session, formatSearchPage(next, true))
  }
  return true
}
