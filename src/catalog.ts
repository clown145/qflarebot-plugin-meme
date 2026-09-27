/**
 * 表情目录：从 meme 服务拉 `/meme/infos`，压成只含匹配与生成所需字段的精简索引，
 * 存进 D1 的一行，每个 isolate 再缓存在内存里。
 *
 * 为什么这样存：
 * - 目录几乎不变、读得多，每次消息都去拉 `/meme/infos`（上百 KB）既费子请求也费 CPU；
 * - 存 D1 而不是 KV：KV 写入全机器人一天只有 1,000 次，这里一次刷新只写 1 行；
 * - 表只有一行（主键 `index`，WITHOUT ROWID），刷新是覆盖，不会越存越多。
 *
 * 各 isolate 每小时用一次「stamp 变了才返回数据」的查询确认一下有没有别处刷新过，
 * 没变时这次查询不回传数据，也就不用重新解析。
 */
import type { PluginContext } from '@qqbot/sdk'
import type { MemeApi, RawMemeInfo, RawOption } from './api.js'

export type OptionType = RawOption['type']

/** 命令行里能写的一个选项；flags 是所有写法，如 `--circle` `-c` `-圆` */
export interface MemeOption {
  name: string
  type: OptionType
  flags: string[]
}

/** 精简后的表情信息。描述、选项的取值范围只在「表情详情」里用，那时再向服务端现查 */
export interface Meme {
  key: string
  keywords: string[]
  /** [最少图, 最多图, 最少字, 最多字] */
  params: [number, number, number, number]
  defaultTexts?: string[]
  options?: MemeOption[]
  tags?: string[]
  /** 创建时间（毫秒），表情列表标「新」用 */
  created?: number
}

export interface Shortcut {
  key: string
  pattern: string
  humanized?: string
  names?: string[]
  texts?: string[]
  options?: Record<string, unknown>
}

export interface CatalogData {
  memes: Meme[]
  shortcuts: Shortcut[]
}

export interface CompiledShortcut {
  shortcut: Shortcut
  meme: Meme
  re: RegExp
}

export interface Catalog extends CatalogData {
  /** 生成这份目录的服务地址，配置里的地址变了就要重建 */
  baseUrl: string
  /** meme 服务版本，每日检查用 */
  version: string
  byKey: Map<string, Meme>
  /** 小写的关键词和 key → 表情 */
  byKeyword: Map<string, Meme>
  /** 小写关键词，按长度从长到短；模糊匹配取最长的那个 */
  keywordsByLength: string[]
  shortcutRules: CompiledShortcut[]
}

/** 与 AstrBot 版一致：long 缺省视为 true；短选项取名字首字符；短别名同时认 `-x` 与 `--x` */
export function optionFlags(option: RawOption): string[] {
  const pf = option.parser_flags ?? {}
  const flags: string[] = []
  if (pf.long !== false) flags.push(`--${option.name}`)
  const first = [...option.name][0]
  if (pf.short && first) flags.push(`-${first}`)
  for (const alias of pf.long_aliases ?? []) flags.push(`--${alias}`)
  for (const alias of pf.short_aliases ?? []) flags.push(`-${alias}`, `--${alias}`)
  return [...new Set(flags)]
}

function nonEmpty<T>(list: T[] | undefined): T[] | undefined {
  return list && list.length ? list : undefined
}

export function buildCatalogData(infos: RawMemeInfo[]): CatalogData {
  const memes: Meme[] = []
  const shortcuts: Shortcut[] = []
  for (const info of infos) {
    if (!info || typeof info.key !== 'string' || !info.params) continue
    const p = info.params
    const created = info.date_created ? Date.parse(info.date_created) : NaN
    const options = (p.options ?? [])
      .map((o) => ({ name: o.name, type: o.type, flags: optionFlags(o) }))
      .filter((o) => o.flags.length > 0)
    const meme: Meme = {
      key: info.key,
      keywords: info.keywords ?? [],
      params: [p.min_images, p.max_images, p.min_texts, p.max_texts],
    }
    const defaultTexts = nonEmpty(p.default_texts)
    if (defaultTexts) meme.defaultTexts = defaultTexts
    const opts = nonEmpty(options)
    if (opts) meme.options = opts
    const tags = nonEmpty(info.tags)
    if (tags) meme.tags = tags
    if (Number.isFinite(created)) meme.created = created
    memes.push(meme)

    for (const sc of info.shortcuts ?? []) {
      if (!sc?.pattern) continue
      const shortcut: Shortcut = { key: info.key, pattern: sc.pattern }
      if (sc.humanized) shortcut.humanized = sc.humanized
      const names = nonEmpty(sc.names)
      if (names) shortcut.names = names
      const texts = nonEmpty(sc.texts)
      if (texts) shortcut.texts = texts
      if (sc.options && Object.keys(sc.options).length) shortcut.options = sc.options
      shortcuts.push(shortcut)
    }
  }
  return { memes, shortcuts }
}

/**
 * 快捷指令的正则是 Rust regex 语法：命名组写作 `(?P<name>…)`，JS 要 `(?<name>…)`。
 * 整句匹配（与 Python 的 fullmatch 一致）。编不过的跳过，不影响其他快捷指令。
 */
export function compileShortcut(pattern: string): RegExp | null {
  const source = `^(?:${pattern.replace(/\(\?P</g, '(?<')})$`
  for (const flags of ['u', '']) {
    try {
      return new RegExp(source, flags)
    } catch {
      // 换个 flags 再试
    }
  }
  return null
}

export function hydrate(data: CatalogData, baseUrl: string, version: string): Catalog {
  const byKey = new Map<string, Meme>()
  const byKeyword = new Map<string, Meme>()
  for (const meme of data.memes) {
    byKey.set(meme.key, meme)
    byKeyword.set(meme.key.toLowerCase(), meme)
    for (const kw of meme.keywords) if (kw) byKeyword.set(kw.toLowerCase(), meme)
  }
  const shortcutRules: CompiledShortcut[] = []
  for (const shortcut of data.shortcuts) {
    const meme = byKey.get(shortcut.key)
    const re = meme ? compileShortcut(shortcut.pattern) : null
    if (meme && re) shortcutRules.push({ shortcut, meme, re })
  }
  const keywordsByLength = [...byKeyword.keys()].sort((a, b) => b.length - a.length)
  return { ...data, baseUrl, version, byKey, byKeyword, keywordsByLength, shortcutRules }
}

// ---------- 存取 ----------

export const CATALOG_DDL = 'CREATE TABLE IF NOT EXISTS {catalog} (k TEXT PRIMARY KEY, stamp TEXT NOT NULL, version TEXT NOT NULL, base_url TEXT NOT NULL, data TEXT NOT NULL) WITHOUT ROWID;'

const ROW_KEY = 'index'
const RECHECK_MS = 60 * 60 * 1000

interface Cached {
  catalog: Catalog
  stamp: string
  checkedAt: number
}

let cached: Cached | undefined
let inflight: Promise<Catalog> | undefined

/** 测试用：清掉 isolate 内的缓存 */
export function resetCatalogCache(): void {
  cached = undefined
  inflight = undefined
}

type Db = PluginContext['db']

async function writeCatalog(db: Db, api: MemeApi, version: string, infos: RawMemeInfo[]): Promise<Catalog> {
  const data = buildCatalogData(infos)
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  await db.run(
    'INSERT INTO {catalog} (k, stamp, version, base_url, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET stamp = excluded.stamp, version = excluded.version, base_url = excluded.base_url, data = excluded.data',
    ROW_KEY,
    stamp,
    version,
    api.baseUrl,
    JSON.stringify(data),
  )
  const catalog = hydrate(data, api.baseUrl, version)
  cached = { catalog, stamp, checkedAt: Date.now() }
  return catalog
}

/** 向服务端重新拉目录并覆盖 D1 那一行 */
export async function refreshCatalog(db: Db, api: MemeApi): Promise<Catalog> {
  const [version, infos] = await Promise.all([api.version().catch(() => ''), api.infos()])
  if (!Array.isArray(infos)) throw new Error('meme 服务返回的表情列表格式不对')
  return writeCatalog(db, api, version, infos)
}

async function load(db: Db, api: MemeApi): Promise<Catalog> {
  const now = Date.now()
  const mine = cached && cached.catalog.baseUrl === api.baseUrl ? cached : undefined
  const row = await db.first<{ stamp: string; version: string; base_url: string; data: string }>(
    'SELECT stamp, version, base_url, data FROM {catalog} WHERE k = ? AND stamp <> ?',
    ROW_KEY,
    mine?.stamp ?? '',
  )
  if (!row) {
    if (mine) {
      mine.checkedAt = now
      return mine.catalog
    }
    return refreshCatalog(db, api)
  }
  if (row.base_url !== api.baseUrl) return refreshCatalog(db, api)
  const catalog = hydrate(JSON.parse(row.data) as CatalogData, row.base_url, row.version)
  cached = { catalog, stamp: row.stamp, checkedAt: now }
  return catalog
}

/** 取目录：内存里有且一小时内确认过就直接用；同一 isolate 里并发的加载合并成一次 */
export async function getCatalog(db: Db, api: MemeApi): Promise<Catalog> {
  if (cached && cached.catalog.baseUrl === api.baseUrl && Date.now() - cached.checkedAt < RECHECK_MS) {
    return cached.catalog
  }
  inflight ??= load(db, api).finally(() => {
    inflight = undefined
  })
  return inflight
}

/**
 * 每日检查：服务端版本变了才重新拉目录。
 * 从没用过（D1 里还没有目录）就不去拉，免得装了没用的机器人也天天请求 meme 服务。
 */
export async function checkCatalogVersion(db: Db, api: MemeApi): Promise<boolean> {
  const row = await db.first<{ version: string; base_url: string }>('SELECT version, base_url FROM {catalog} WHERE k = ?', ROW_KEY)
  if (!row) return false
  const version = await api.version()
  if (row.base_url === api.baseUrl && row.version === version && version) return false
  await writeCatalog(db, api, version, await api.infos())
  return true
}
