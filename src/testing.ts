/**
 * 测试用的 ScopedDB：Node 自带的 SQLite（node:sqlite，Node 22.5+），SQL 先过框架同一份表名检查（sqlScope）。
 * 测试里跑的就是真 SQL：UPSERT、WITHOUT ROWID、changes 计数都与 D1 一致；
 * 写了不带 {表名} 占位的 SQL 也会像线上一样直接报错。
 *
 * 只给测试用，插件入口不引用它，不会打进 plugin.js。
 */
import type { ScopedDB } from '@qqbot/sdk'

interface Statement {
  run(...params: unknown[]): { changes: number | bigint }
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
}

interface Database {
  exec(sql: string): void
  prepare(sql: string): Statement
}

interface SqlScope {
  scopeSql(sql: string, prefix: string): string
  tablePrefix(plugin: string): string
  flattenForExec(sql: string): string
}

// specifier 放在变量里：插件的 tsconfig 只带 Workers 类型，没有 @types/node；
// sqlScope 直接用并排的 QFlareBot 源码，与 CI 的目录布局一致
const SQLITE = 'node:sqlite'
const SQL_SCOPE = new URL('../../QFlareBot/packages/runtime/src/sqlScope.ts', (import.meta as { url: string }).url).pathname

export interface TestDB extends ScopedDB {
  /** 累计改动的行数（D1 按这个计写入） */
  readonly rowsWritten: number
  /** 累计执行的查询次数（first / all） */
  readonly reads: number
  /** 直接查底层库，不走表名检查 */
  raw<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[]
}

export async function createTestDB(plugin = 'meme'): Promise<TestDB> {
  const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => Database }
  const { scopeSql, tablePrefix, flattenForExec } = (await import(SQL_SCOPE)) as SqlScope
  const db = new DatabaseSync(':memory:')
  const prefix = tablePrefix(plugin)
  const scoped = (sql: string) => scopeSql(sql, prefix)
  let rowsWritten = 0
  let reads = 0
  return {
    get rowsWritten() {
      return rowsWritten
    },
    get reads() {
      return reads
    },
    table: (name) => prefix + name,
    async exec(sql) {
      db.exec(flattenForExec(scoped(sql)))
    },
    async run(sql, ...params) {
      const changes = Number(db.prepare(scoped(sql)).run(...params).changes)
      rowsWritten += changes
      return { changes }
    },
    async all<T>(sql: string, ...params: unknown[]) {
      reads++
      return db.prepare(scoped(sql)).all(...params) as T[]
    },
    async first<T>(sql: string, ...params: unknown[]) {
      reads++
      return (db.prepare(scoped(sql)).get(...params) ?? null) as T | null
    },
    raw<T>(sql: string, ...params: unknown[]) {
      return db.prepare(sql).all(...params) as T[]
    },
  }
}
