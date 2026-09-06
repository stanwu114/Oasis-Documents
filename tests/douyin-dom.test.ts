import {test} from 'node:test'
import assert from 'node:assert/strict'
import {loadPlatform} from './load-platform.cjs'
const {extractRenderedAlbum}=loadPlatform('douyin-dom')
const id='7671080912620244239',description='投资人最怕的不是创始人吵架'
const view={url:`https://www.douyin.com/note/${id}`,title:description,album:{total:2,images:['https://example.com/a.webp','https://example.com/a.webp','https://example.com/b.webp']}}
test('图集重复轮播节点去重，保留图片顺序',()=>{
  assert.deepEqual(extractRenderedAlbum(view,id,description).images,['https://example.com/a.webp','https://example.com/b.webp'])
})
test('图集必须完整且作品和描述均匹配',()=>{
  assert.equal(extractRenderedAlbum({...view,album:{...view.album,total:3}},id,description),null)
  assert.equal(extractRenderedAlbum({...view,title:'这是另一条完全不同的作品'},id,description),null)
  assert.equal(extractRenderedAlbum(view,'1234567890123456789',description),null)
  assert.equal(extractRenderedAlbum(view,id),null)
})
