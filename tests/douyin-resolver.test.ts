import {test} from 'node:test'
import assert from 'node:assert/strict'
import {loadPlatform} from './load-platform.cjs'
const {douyinPostId,isDouyinUrl} = loadPlatform('douyin-link')
const {resolveDouyin} = loadPlatform('douyin-resolver')
const id='7675581342318447907'
const html=`<script>window._ROUTER_DATA=${JSON.stringify({detail:{aweme_id:id,desc:'DIY 橱柜',video:{play_addr:{url_list:['https://example.com/post.mp4']}}}})}</script>`
test('收藏页 modal_id、作品路径和 App 参数识别', () => {
  for(const url of [`https://www.douyin.com/user/self?from_tab_name=main&modal_id=${id}&showTab=favorite_collection`,`https://www.douyin.com/note/${id}`,`https://www.iesdouyin.com/share/video/${id}/`,`https://www.douyin.com/?aweme_id=${id}`]) assert.equal(douyinPostId(url),id)
  assert.equal(douyinPostId('https://www.douyin.com/user/self'),undefined)
  assert.equal(isDouyinUrl(`https://evil.example/video/${id}?next=https://www.douyin.com`),false)
})
test('收藏页只取 modal_id 对应作品，不请求收藏列表', async () => {
  const urls:string[]=[]
  const result=await resolveDouyin(`https://www.douyin.com/user/self?modal_id=${id}`,async(url:string)=>{urls.push(url);return{finalUrl:url,html}})
  assert.deepEqual(urls,[`https://www.iesdouyin.com/share/video/${id}/`])
  assert.equal(result.url,`https://www.douyin.com/video/${id}`)
})
test('短链先解析跳转；移动页数据缺失可回退到网页作品数据', async () => {
  const urls:string[]=[]
  const result=await resolveDouyin('https://v.douyin.com/example/',async(url:string)=>{urls.push(url);return{finalUrl:`https://www.iesdouyin.com/share/video/${id}/`,html:url.includes('www.douyin.com/video')?html:'<html>shell</html>'}})
  assert.equal(result.post.id,id)
  assert.equal(urls.length,3)
})
test('所有页面缺失数据会结束，不生成假的成功卡片', async () => {
  let calls=0
  await assert.rejects(resolveDouyin(`https://www.douyin.com/video/${id}`,async(url:string)=>{calls++;return{finalUrl:url,html:'<html>login</html>'}}),/未返回可下载内容/)
  assert.equal(calls,2)
})
test('取消后不继续发起页面请求', async () => {
  const controller=new AbortController();controller.abort()
  await assert.rejects(resolveDouyin(`https://www.douyin.com/video/${id}`,async()=>{assert.fail('不应请求')},controller.signal))
})

test('HTML 无数据时加载应用浏览器，仍校验作品编号', async () => {
  let renderedId=''
  const reader=async(url:string)=>({finalUrl:url,html:'<html>shell</html>'})
  const result=await resolveDouyin(`https://www.douyin.com/user/self?modal_id=${id}`,reader,undefined,async(target:string)=>{renderedId=target;return{id:target,desc:'DIY',videoUrl:'https://example.com/v.mp4'}})
  assert.equal(renderedId,id)
  assert.equal(result.post.desc,'DIY')
  await assert.rejects(resolveDouyin(`https://www.douyin.com/video/${id}`,reader,undefined,async()=>({id:'1111111111111111111',videoUrl:'https://example.com/wrong.mp4'})),/不一致/)
})
test('静态数据已足够时不启动浏览器', async () => {
  const result=await resolveDouyin(`https://www.douyin.com/video/${id}`,async(url:string)=>({finalUrl:url,html}),undefined,async()=>assert.fail('不应启动浏览器'))
  assert.equal(result.post.id,id)
})
