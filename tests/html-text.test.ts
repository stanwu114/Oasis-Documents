/** 收藏全文抽取:段落结构保持(阅读弹窗按 \n\n 分段渲染) */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as cheerio from 'cheerio'
import { extractBody, domToText } from '../src/main/platforms/html-text.ts'

test('段落保持:p 与 p 之间有空行,不再压成一段文字墙', () => {
  const html = '<article><p>第一段讲架构。</p><p>第二段讲实现。</p><p>第三段讲验收。</p></article>'
  const $ = cheerio.load(html)
  const text = extractBody($, ['article'])
  const paras = text.split('\n\n')
  assert.ok(paras.length >= 3, `应至少 3 段,实际 ${paras.length}: ${JSON.stringify(text)}`)
  assert.ok(text.includes('第一段'))
  assert.ok(text.includes('第三段'))
})

test('br 换行与列表项分段', () => {
  const html = '<main><p>标题行<br>副标题行</p><ul><li>要点一</li><li>要点二</li></ul></main>'
  const $ = cheerio.load(html)
  const text = extractBody($, ['main'])
  assert.ok(text.includes('\n'), 'br 应产生换行')
  assert.ok(text.includes('要点一') && text.includes('要点二'))
})

test('脚本与导航噪音剔除', () => {
  const html = `<body><nav>首页 论坛</nav><script>var x = 1</script>
    <p>${'正文'.repeat(60)}</p><footer>版权所有</footer></body>`
  const $ = cheerio.load(html)
  const text = extractBody($, ['#content'])
  assert.ok(!text.includes('var x'))
  assert.ok(!text.includes('首页'))
  assert.ok(text.includes('正文'))
})

test('短内容兜底整个 body(同样保留段落)', () => {
  const html = '<body><div>短句</div><p>另一段</p></body>'
  const $ = cheerio.load(html)
  const text = extractBody($, ['article'])
  assert.ok(text.includes('短句') && text.includes('另一段'))
})

test('domToText:连续空行收敛为单个空行', () => {
  const $ = cheerio.load('<div><p>a</p><p>b</p><p>c</p></div>')
  const text = domToText($('div'))
  assert.ok(!text.includes('\n\n\n'), JSON.stringify(text))
})
