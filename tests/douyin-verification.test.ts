import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {loadPlatform} from './load-platform.cjs'

function fixture(view: object = {}) {
  const id='1234567890123456789'
  let protocolHandler: any
  let window: any
  let removed=false
  const isolated={
    setPermissionRequestHandler() {},setPermissionCheckHandler() {},clearStorageData:async()=>{},
    webRequest:{onBeforeRequest(_handler: any){}},
    protocol:{handle(_scheme:string,handler:any){protocolHandler=handler},unhandle(){removed=true}},
    fetch:async()=>Response.json({aweme_detail:{aweme_id:id,desc:'作者更新后的正文',video:{play_addr:{url_list:['https://example.com/video.mp4']}}}})
  }
  class Window extends EventEmitter {
    visible=false; destroyed=false; title=''
    webContents=Object.assign(new EventEmitter(),{setAudioMuted(){},getUserAgent:()=>'',setUserAgent(){},setWindowOpenHandler(){},isDestroyed:()=>false,debugger:{isAttached:()=>false},executeJavaScript:async()=>({url:`https://www.douyin.com/video/${id}`,html:'',sources:[],videoCount:0,...view})})
    constructor(){super();window=this}
    setTitle(title:string){this.title=title}
    show(){this.visible=true}
    isDestroyed(){return this.destroyed}
    destroy(){this.destroyed=true;this.emit('closed')}
    async loadURL(){}
  }
  const {readRenderedDouyin}=loadPlatform('douyin-browser',{electron:{BrowserWindow:Window,session:{fromPartition:()=>isolated}}})
  return {id,readRenderedDouyin,get window(){return window},get removed(){return removed},async challenge(){window.webContents.executeJavaScript=async()=>({url:`https://www.douyin.com/video/${id}`,html:'',sources:[],videoCount:0,verification:true});window.webContents.emit('dom-ready');await Promise.resolve()},reply(){return protocolHandler(new Request('https://www.douyin.com/aweme/v1/web/aweme/detail/'))}}
}

test('遇到验证码显示窗口，验证后目标数据返回即继续；ID 一致不因文案变化拒绝', async () => {
  const f=fixture();let prompts=0
  const result=f.readRenderedDouyin(f.id,undefined,undefined,'分享时的旧正文与当前不同',()=>prompts++)
  await Promise.resolve();
  await f.challenge();await f.challenge()
  assert.equal(f.window.visible,true);assert.equal(prompts,1)
  await f.reply()
  assert.equal((await result).id,f.id)
  assert.equal(f.window.destroyed,true);assert.equal(f.removed,true)
})
test('等待验证时取消会关闭窗口并结束任务', async () => {
  const f=fixture(),controller=new AbortController()
  const result=f.readRenderedDouyin(f.id,controller.signal)
  await Promise.resolve();
  await f.challenge();controller.abort()
  await assert.rejects(result,/验证尚未完成/)
  assert.equal(f.window.destroyed,true);assert.equal(f.removed,true)
})

test('图集页面没有 h1 或详情 API 时按作品 ID 和文案读取完整图集', async () => {
  const f=fixture({title:'投资人最怕的不是创始人吵架',album:{total:2,images:['https://example.com/a.webp','https://example.com/b.webp']}})
  const result=f.readRenderedDouyin(f.id,undefined,undefined,'投资人最怕的不是创始人吵架')
  await Promise.resolve();f.window.webContents.emit('dom-ready')
  assert.equal((await result).images.length,2)
  assert.equal(f.window.visible,false)
  assert.equal(f.removed,true)
})
test('主动关闭窗口提供取消说明，并清理解析资源', async () => {
  const f=fixture(),result=f.readRenderedDouyin(f.id)
  await Promise.resolve();f.window.destroy()
  await assert.rejects(result,/导入已取消/)
  assert.equal(f.removed,true)
})
