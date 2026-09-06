import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {loadPlatform} from './load-platform.cjs'
const {useNodeTransport}=loadPlatform('browser-transport')

test('浏览器资源传输保留会话，识别批量作品详情，注销处理器', async () => {
  let handler: (request: Request) => Promise<Response>
  let removed=false
  const cookies: {name:string;value:string}[]=[]
  let captured:unknown
  const target={protocol:{handle:(_scheme:string, callback: typeof handler)=>{handler=callback},unhandle:()=>{removed=true}},cookies:{get:async()=>cookies,set:async(cookie:{name:string;value:string})=>{cookies.push(cookie)}},fetch:async()=>{throw new Error('此测试不需要原生网络')}}
  const server=createServer((request,response)=>{
    if(request.url==='/cookie') {response.setHeader('set-cookie','session=fixture; HttpOnly; Path=/');response.end('ok')}
    else {assert.equal(request.headers.cookie,'session=fixture');response.setHeader('content-type','application/json');response.end(JSON.stringify({aweme_details:[{aweme_id:'7675581342318447907',desc:'DIY'}]}))}
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`
  const cleanup=useNodeTransport(target,new AbortController().signal,(_url:string,data:unknown)=>{captured=data})
  try {
    assert.equal(await (await handler!(new Request(`${base}/cookie`))).text(),'ok')
    const response=await handler!(new Request(`${base}/aweme/v1/web/multi/aweme/detail/`))
    assert.deepEqual(await response.json(),captured)
    assert.deepEqual(captured,{aweme_details:[{aweme_id:'7675581342318447907',desc:'DIY'}]})
  } finally {cleanup();assert.equal(removed,true);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})

test('单条详情原生网络失败后改用 Node HTTPS 路径，不重复调用失败路径', async () => {
  let handler:any, nativeCalls=0,captured:any
  const server=createServer((_request,response)=>{response.setHeader('content-type','application/json');response.end(JSON.stringify({aweme_detail:{aweme_id:'1234567890123456789'}}))})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const target={protocol:{handle(_scheme:string,callback:any){handler=callback},unhandle(){}},cookies:{get:async()=>[]},fetch:async()=>{nativeCalls++;throw new Error('connection reset')}}
  const cleanup=useNodeTransport(target,new AbortController().signal,(_url:string,body:any)=>{captured=body})
  try {
    const response=await handler(new Request(`http://127.0.0.1:${(server.address() as {port:number}).port}/aweme/v1/web/aweme/detail/`))
    assert.equal(response.status,200);assert.equal(nativeCalls,1);assert.equal(captured.aweme_detail.aweme_id,'1234567890123456789')
    await response.text()
  } finally {cleanup();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
