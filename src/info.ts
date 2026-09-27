import type { RawMemeInfo, RawOption } from './api.js'

/** 展示用的写法，与上游一致（短别名只写 `-x`；解析时 `--x` 也认） */
function displayFlags(option: RawOption): string[] {
  const pf = option.parser_flags ?? {}
  const flags: string[] = []
  if (pf.long !== false) flags.push(`--${option.name}`)
  const first = [...option.name][0]
  if (pf.short && first) flags.push(`-${first}`)
  for (const alias of pf.long_aliases ?? []) flags.push(`--${alias}`)
  for (const alias of pf.short_aliases ?? []) flags.push(`-${alias}`)
  return flags
}

/**
 * 一个选项的说明。AstrBot 版的模型没声明 choices / minimum / maximum，
 * 解析时被丢掉了，所以「可选值、最小、最大」从来没显示过；这里直接读服务端原样返回的字段。
 */
export function formatOption(option: RawOption): string {
  let text = `  ${displayFlags(option).join('/')}`
  if (option.type !== 'boolean') text += ` <${option.type.toUpperCase()}>`
  text += `\n    说明: ${option.description || '无'}`
  const extra: string[] = []
  if (option.type === 'integer' || option.type === 'float') {
    if (option.minimum != null) extra.push(`最小: ${option.minimum}`)
    if (option.maximum != null) extra.push(`最大: ${option.maximum}`)
  }
  if (option.type === 'string' && option.choices?.length) extra.push(`可选: ${option.choices.join(', ')}`)
  if (option.default != null) extra.push(`默认: ${String(option.default)}`)
  if (extra.length) text += ` (${extra.join(' | ')})`
  return text
}

function count(min: number, max: number): string {
  return min === max ? `${min}` : `${min} ~ ${max}`
}

export function formatInfo(info: RawMemeInfo): string {
  const p = info.params
  const lines = [`表情名：${info.key}`, `关键词：${(info.keywords ?? []).join(', ')}`]
  const shortcuts = (info.shortcuts ?? []).map((s) => s.humanized || s.pattern).filter(Boolean)
  if (shortcuts.length) lines.push(`快捷指令：${shortcuts.join(', ')}`)
  if (info.tags?.length) lines.push(`标签：${info.tags.join(', ')}`)
  lines.push(`需要图片数：${count(p.min_images, p.max_images)}`)
  lines.push(`需要文字数：${count(p.min_texts, p.max_texts)}`)
  if (p.default_texts?.length) lines.push(`默认文字：${p.default_texts.join(', ')}`)
  let text = lines.join('\n')
  if (p.options?.length) text += `\n\n--- 可选选项 ---\n${p.options.map(formatOption).join('\n')}`
  return `${text}\n\n--- 表情预览 ---`
}
