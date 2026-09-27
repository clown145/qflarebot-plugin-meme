import { describe, expect, it } from 'vitest'
import { createMockSession } from '@qqbot/sdk/testing'
import type { RawMemeInfo } from './api.js'
import { ArgError, parseArgs, splitArgs } from './args.js'
import { buildCatalogData, compileShortcut, hydrate, optionFlags, type MemeOption } from './catalog.js'
import { resolveSettings } from './config.js'
import { addressedText, matchMeme } from './match.js'
import { absoluteDuration, centeredCrop, parseCropBox, parseResize, relativeDuration } from './tools.js'

const CIRCLE: MemeOption = { name: 'circle', type: 'boolean', flags: ['--circle', '-c', '-圆', '--圆'] }
const NUMBER: MemeOption = { name: 'number', type: 'integer', flags: ['--number', '-n'] }
const GENDER: MemeOption = { name: 'gender', type: 'string', flags: ['--gender', '-g'] }

describe('splitArgs', () => {
  it('按空白切，引号里的空格保留', () => {
    expect(splitArgs('  a  "b c"  \'d e\' f\\ g ')).toEqual(['a', 'b c', 'd e', 'f g'])
  })

  it('引号不成对时退回按空白切（与 AstrBot 版遇到 ValueError 时一致）', () => {
    expect(splitArgs("I'm fine")).toEqual(["I'm", 'fine'])
  })
})

describe('parseArgs', () => {
  it('认得的选项进 options，其余当文字', () => {
    expect(parseArgs(['你好', '-圆', '--number', '3', '世界'], [CIRCLE, NUMBER])).toEqual({
      texts: ['你好', '世界'],
      options: { circle: true, number: 3 },
    })
  })

  it('支持 = 写法、长选项唯一前缀缩写、-- 之后全当文字', () => {
    expect(parseArgs(['--num=5', '--gen', 'male', '--', '-c'], [CIRCLE, NUMBER, GENDER])).toEqual({
      texts: ['-c'],
      options: { number: 5, gender: 'male' },
    })
  })

  it('负数和不认识的 -x 当文字', () => {
    expect(parseArgs(['-1', '-0.5', '-x'], [CIRCLE])).toEqual({ texts: ['-1', '-0.5', '-x'], options: {} })
  })

  it('类型不对或缺值时报可读的错', () => {
    expect(() => parseArgs(['-n', 'abc'], [NUMBER])).toThrow(ArgError)
    expect(() => parseArgs(['--number'], [NUMBER])).toThrow('后面要跟一个值')
  })

  it('只返回写了的选项，不把默认值塞进去', () => {
    expect(parseArgs([], [CIRCLE, NUMBER]).options).toEqual({})
  })
})

describe('optionFlags', () => {
  it('长选项、首字母短选项、长短别名都认', () => {
    expect(
      optionFlags({
        type: 'boolean',
        name: 'circle',
        parser_flags: { short: true, long: true, short_aliases: ['圆'], long_aliases: ['yuan'] },
      }),
    ).toEqual(['--circle', '-c', '--yuan', '-圆', '--圆'])
  })
})

describe('compileShortcut', () => {
  it('把 Rust 的 (?P<name>) 转成 JS 命名组，并且整句匹配', () => {
    const re = compileShortcut('满脑子都是(?P<name>\\S+)')!
    expect(re.exec('满脑子都是张三')?.groups).toEqual({ name: '张三' })
    expect(re.test('我满脑子都是张三')).toBe(false)
  })

  it('编不过的正则返回 null', () => {
    expect(compileShortcut('(')).toBeNull()
  })
})

const INFOS: RawMemeInfo[] = [
  {
    key: 'petpet',
    params: { min_images: 1, max_images: 1, min_texts: 0, max_texts: 0 },
    keywords: ['摸', '摸摸'],
  },
  {
    key: 'doraemon_say',
    params: { min_images: 0, max_images: 0, min_texts: 1, max_texts: 1 },
    keywords: ['哆啦A梦说'],
  },
  {
    key: 'fill_head',
    params: { min_images: 1, max_images: 1, min_texts: 0, max_texts: 0 },
    keywords: ['满脑子'],
    shortcuts: [{ pattern: '满脑子都是(?P<name>\\S+)', names: ['{name}'], humanized: '满脑子都是xx' }],
  },
  {
    key: 'wujing',
    params: { min_images: 0, max_images: 0, min_texts: 2, max_texts: 2 },
    keywords: ['吴京中国'],
    shortcuts: [{ pattern: '吴京[\\s:：]*(?P<left>\\S*)中国(?P<right>\\S*)', texts: ['{left}', '{right}'] }],
  },
]

describe('matchMeme', () => {
  const catalog = hydrate(buildCatalogData(INFOS), 'https://meme.test', '1')

  it('首词精确匹配，关键词和 key 都不分大小写', () => {
    expect(matchMeme(catalog, '哆啦a梦说 你好', false)).toMatchObject({ meme: { key: 'doraemon_say' }, rest: '你好' })
    expect(matchMeme(catalog, 'PETPET', false)?.meme.key).toBe('petpet')
  })

  it('模糊匹配取最长的关键词', () => {
    expect(matchMeme(catalog, '摸摸头', true)).toMatchObject({ meme: { key: 'petpet' }, rest: '头' })
    expect(matchMeme(catalog, '摸摸头', false)).toBeNull()
  })

  it('快捷指令先于关键词，占位换成捕获组', () => {
    expect(matchMeme(catalog, '满脑子都是张三', true)).toMatchObject({
      meme: { key: 'fill_head' },
      shortcut: { names: ['张三'], texts: [] },
    })
    expect(matchMeme(catalog, '吴京：我爱中国人', false)?.shortcut?.texts).toEqual(['我爱', '人'])
  })
})

describe('addressedText', () => {
  const settings = resolveSettings({ base_url: 'https://meme.test', prefixes: ['/', '-'] })

  it('带前缀的算，并标记为 prefixed', () => {
    expect(addressedText(createMockSession({ content: '-摸', atMe: false }), settings)).toEqual({ text: '摸', prefixed: true })
  })

  it('@ 机器人不用前缀；没 @ 也没前缀的不算', () => {
    expect(addressedText(createMockSession({ content: '摸', atMe: true }), settings)).toEqual({ text: '摸', prefixed: false })
    expect(addressedText(createMockSession({ content: '摸', atMe: false }), settings)).toBeNull()
    expect(addressedText(createMockSession({ content: '摸', atMe: false }), { ...settings, bareKeywords: true })).not.toBeNull()
  })
})

describe('图片工具参数', () => {
  it('缩放', () => {
    expect(parseResize('100x200')).toEqual({ width: 100, height: 200 })
    expect(parseResize('x200')).toEqual({ width: null, height: 200 })
    expect(() => parseResize('abc')).toThrow(ArgError)
  })

  it('裁剪：坐标直接用，尺寸和比例按原图居中', () => {
    expect(parseCropBox('0,0,100,100')).toEqual({ left: 0, top: 0, right: 100, bottom: 100 })
    expect(parseCropBox('16:9')).toBeNull()
    expect(centeredCrop('100x100', { width: 300, height: 200 })).toEqual({ left: 100, top: 50, right: 200, bottom: 150 })
    expect(centeredCrop('1:1', { width: 300, height: 200 })).toEqual({ left: 50, top: 0, right: 250, bottom: 200 })
    expect(() => parseCropBox('大一点')).toThrow(ArgError)
  })

  it('变速：帧率和时长直接换算，倍速和百分比按原图帧间隔', () => {
    expect(absoluteDuration('20fps')).toBeCloseTo(0.05)
    expect(absoluteDuration('50ms')).toBeCloseTo(0.05)
    expect(absoluteDuration('2x')).toBeNull()
    expect(relativeDuration('2x', { average_duration: 0.1 })).toBeCloseTo(0.05)
    expect(relativeDuration('50%', { average_duration: 0.1 })).toBeCloseTo(0.2)
    expect(() => absoluteDuration('100fps')).toThrow('0.02')
  })
})
