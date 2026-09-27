/**
 * 等待用户接着发的会话（补参数、搜索翻页），存在 D1。
 *
 * 表不会越存越多：
 * - 一个人在一个会话（群/单聊）里最多一行，主键是 `场景:会话:用户`，新会话覆盖旧的；
 * - 做完、取消都删掉这一行；
 * - 超时没人理的行，读的时候当它不存在，每天的定时任务一条 DELETE 清掉。
 *
 * 写入：开一次会话 1 行，补一次 1 行，结束 1 行。表是 WITHOUT ROWID 且只有主键，没有额外的索引行。
 * 平时每条消息只多一次主键读。
 *
 * 同一个人几乎同时发两条时可能落在两个 isolate：更新和收尾都带版本号条件，
 * 抢输的那条什么也不做，保证只生成一次、也不会拿旧状态覆盖新状态。
 */
import type { PluginContext, Session } from '@qqbot/sdk'
import type { ImageSource } from './images.js'

export const SESSIONS_DDL = 'CREATE TABLE IF NOT EXISTS {sessions} (k TEXT PRIMARY KEY, v INTEGER NOT NULL, expires INTEGER NOT NULL, data TEXT NOT NULL) WITHOUT ROWID;'

/** 等着补参数的表情 */
export interface MemeState {
  kind: 'meme'
  key: string
  /** [最少图, 最多图, 最少字, 最多字]，续接时不必再读目录 */
  params: [number, number, number, number]
  texts: string[]
  images: ImageSource[]
  options: Record<string, unknown>
}

/** 搜索结果翻页；存排好版的行，翻页时不必再读目录 */
export interface SearchState {
  kind: 'search'
  query: string
  lines: string[]
  page: number
}

export type WaitState = MemeState | SearchState

export interface Stored {
  state: WaitState
  version: number
}

type Db = PluginContext['db']

/** 会话的主键；缺目标或用户时不能续接 */
export function sessionKey(session: Session): string | null {
  if (!session.targetId || !session.userId) return null
  return `${session.scene}:${session.targetId}:${session.userId}`
}

export async function loadWait(db: Db, key: string, now = Date.now()): Promise<Stored | null> {
  const row = await db.first<{ v: number; data: string }>('SELECT v, data FROM {sessions} WHERE k = ? AND expires > ?', key, now)
  if (!row) return null
  try {
    return { state: JSON.parse(row.data) as WaitState, version: Number(row.v) }
  } catch {
    return null
  }
}

/** 开一个新会话，同一个人之前的会话被覆盖 */
export async function saveWait(db: Db, key: string, state: WaitState, expires: number): Promise<void> {
  await db.run(
    'INSERT INTO {sessions} (k, v, expires, data) VALUES (?, 1, ?, ?) ON CONFLICT(k) DO UPDATE SET v = v + 1, expires = excluded.expires, data = excluded.data',
    key,
    expires,
    JSON.stringify(state),
  )
}

/** 按版本号更新；别处已经改过（或已结束）时返回 false */
export async function updateWait(db: Db, key: string, version: number, state: WaitState, expires: number): Promise<boolean> {
  const { changes } = await db.run(
    'UPDATE {sessions} SET v = v + 1, expires = ?, data = ? WHERE k = ? AND v = ?',
    expires,
    JSON.stringify(state),
    key,
    version,
  )
  return changes > 0
}

/** 收尾：按版本号删掉，删到了才算抢到这次生成 */
export async function claimWait(db: Db, key: string, version: number): Promise<boolean> {
  const { changes } = await db.run('DELETE FROM {sessions} WHERE k = ? AND v = ?', key, version)
  return changes > 0
}

export async function dropWait(db: Db, key: string): Promise<void> {
  await db.run('DELETE FROM {sessions} WHERE k = ?', key)
}

/** 每日清理超时没人理的会话 */
export async function purgeExpired(db: Db, now = Date.now()): Promise<number> {
  const { changes } = await db.run('DELETE FROM {sessions} WHERE expires <= ?', now)
  return changes
}
