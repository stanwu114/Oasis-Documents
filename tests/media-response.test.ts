import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {localMediaResponse} from '../src/main/media-response.ts'

test('本地视频 Range 返回正确片段与长度，支持跳播和尾部元数据读取', async () => {
  const dir=await mkdtemp(join(tmpdir(),'oasis-range-')),path=join(dir,'video.mp4')
  await writeFile(path,Buffer.from('0123456789'))
  const request=(range?:string,method='GET')=>new Request('https://local.test/video',{method,headers:range?{Range:range}:{}})
  try {
    const partial=await localMediaResponse(path,request('bytes=3-6'))
    assert.equal(partial.status,206);assert.equal(partial.headers.get('Content-Range'),'bytes 3-6/10');assert.equal(partial.headers.get('Content-Length'),'4');assert.equal(await partial.text(),'3456')
    assert.equal(await (await localMediaResponse(path,request('bytes=-3'))).text(),'789')
    assert.equal(await (await localMediaResponse(path,request('bytes=7-'))).text(),'789')
    const head=await localMediaResponse(path,request(undefined,'HEAD'));assert.equal(head.headers.get('Content-Length'),'10');assert.equal(await head.text(),'')
    for(const range of ['bytes=10-','bytes=5-2','bytes=-0','bytes=0-1,3-4']) assert.equal((await localMediaResponse(path,request(range))).status,416)
  } finally {await rm(dir,{recursive:true,force:true})}
})
