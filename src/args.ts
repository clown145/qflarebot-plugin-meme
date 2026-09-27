/**
 * 命令行参数解析，对应 AstrBot 版的 shlex.split + argparse.parse_known_args：
 * 认得的选项进 options，其余都当文字。
 */
import type { MemeOption } from './catalog.js'

export class ArgError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArgError'
  }
}

/** 类 shlex 的切分：按空白分词，支持单双引号与反斜杠转义；引号不成对时退回按空白切 */
export function splitArgs(text: string): string[] {
  const out: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && (text[i + 1] === '"' || text[i + 1] === '\\')) current += text[++i]
      else current += ch
      continue
    }
    if (/\s/.test(ch)) {
      if (started) out.push(current)
      current = ''
      started = false
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (ch === '\\' && i + 1 < text.length) {
      current += text[++i]
      started = true
    } else {
      current += ch
      started = true
    }
  }
  if (quote) return text.split(/\s+/).filter(Boolean)
  if (started) out.push(current)
  return out
}

/** argparse 在没有「长得像负数」的选项时，把 -1、-0.5 当普通参数 */
const NEGATIVE_NUMBER = /^-(\d+|\d*\.\d+)$/

const TRUE_WORDS = new Set(['true', '1', 'yes', 'on', '是'])
const FALSE_WORDS = new Set(['false', '0', 'no', 'off', '否'])

function convert(option: MemeOption, flag: string, raw: string): unknown {
  switch (option.type) {
    case 'integer':
      if (!/^[+-]?\d+$/.test(raw)) throw new ArgError(`${flag} 需要一个整数，收到「${raw}」`)
      return Number.parseInt(raw, 10)
    case 'float': {
      const n = Number(raw)
      if (raw.trim() === '' || !Number.isFinite(n)) throw new ArgError(`${flag} 需要一个数字，收到「${raw}」`)
      return n
    }
    case 'boolean': {
      const v = raw.toLowerCase()
      if (TRUE_WORDS.has(v)) return true
      if (FALSE_WORDS.has(v)) return false
      throw new ArgError(`${flag} 只能是 true 或 false`)
    }
    default:
      return raw
  }
}

export interface ParsedArgs {
  texts: string[]
  options: Record<string, unknown>
}

/**
 * 按表情声明的选项解析。支持 `--name value`、`--name=value`、长选项的唯一前缀缩写（argparse 默认行为）、
 * `--` 之后全部当文字。不认识的 `-x` 原样当文字，与 parse_known_args 一致。
 * 只返回用户写了的选项，默认值交给服务端——AstrBot 版把默认值也塞进去，还因为可变默认参数让选项串到了后面的请求里。
 */
export function parseArgs(tokens: string[], options: MemeOption[] = []): ParsedArgs {
  const byFlag = new Map<string, MemeOption>()
  for (const option of options) for (const flag of option.flags) byFlag.set(flag, option)
  const longFlags = [...byFlag.keys()].filter((f) => f.startsWith('--'))

  const lookup = (flag: string): MemeOption | undefined => {
    const exact = byFlag.get(flag)
    if (exact || !flag.startsWith('--') || flag.length < 3) return exact
    const candidates = new Set(longFlags.filter((f) => f.startsWith(flag)).map((f) => byFlag.get(f)!))
    return candidates.size === 1 ? [...candidates][0] : undefined
  }

  const texts: string[] = []
  const values: Record<string, unknown> = {}
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === '--') {
      texts.push(...tokens.slice(i + 1))
      break
    }
    if (!token.startsWith('-') || token === '-' || NEGATIVE_NUMBER.test(token)) {
      texts.push(token)
      continue
    }
    const eq = token.indexOf('=')
    const flag = eq > 0 ? token.slice(0, eq) : token
    const option = lookup(flag)
    if (!option) {
      texts.push(token)
      continue
    }
    if (option.type === 'boolean') {
      values[option.name] = eq > 0 ? convert(option, flag, token.slice(eq + 1)) : true
      continue
    }
    let raw: string
    if (eq > 0) {
      raw = token.slice(eq + 1)
    } else {
      const next = tokens[i + 1]
      if (next === undefined) throw new ArgError(`${flag} 后面要跟一个值`)
      raw = next
      i++
    }
    values[option.name] = convert(option, flag, raw)
  }
  return { texts, options: values }
}
