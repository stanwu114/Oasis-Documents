import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import sharp from 'sharp'

/** 流式计算文件 SHA-256（大文件不爆内存） */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * 图片感知哈希（pHash，64 bit → 16 位 hex）
 * 流程：缩放到 32x32 灰度 → DCT → 取左上角 8x8 低频 → 中值比较
 * 相同图片的缩放/轻微压缩/水印不会改变哈希（HEIC 先经 sips 桥接）
 */
export async function phashImage(path: string): Promise<string> {
  const { ensureDecodableImage } = await import('../image-decode')
  const decodable = await ensureDecodableImage(path)
  const size = 32
  const { data } = await sharp(decodable)
    .grayscale()
    .resize(size, size, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true })

  // DCT-II
  const pixels = new Float64Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      pixels[y * size + x] = data[y * size + x]
    }
  }
  const dct = dct2d(pixels, size)

  // 取左上 8x8（跳过 DC 项的绝对值，用相对中值更稳）
  const lowFreq: number[] = []
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (x === 0 && y === 0) continue
      lowFreq.push(dct[y * size + x])
    }
  }
  lowFreq.sort((a, b) => a - b)
  const median = lowFreq[Math.floor(lowFreq.length / 2)]

  let bits = 0n
  let bitPos = 0
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (x === 0 && y === 0) continue
      if (dct[y * size + x] > median) bits |= 1n << BigInt(bitPos)
      bitPos++
    }
  }
  return bits.toString(16).padStart(16, '0')
}

/** 两哈希的汉明距离（≤5 视为近似相同） */
export function hammingDistance(a: string, b: string): number {
  const x = BigInt(`0x${a}`)
  const y = BigInt(`0x${b}`)
  let diff = x ^ y
  let count = 0
  while (diff) {
    if (diff & 1n) count++
    diff >>= 1n
  }
  return count
}

/** 一维 DCT 行变换 + 列变换（32x32 足够小，直接算） */
function dct2d(input: Float64Array, n: number): Float64Array {
  const cosTable = new Float64Array(n * n)
  for (let k = 0; k < n; k++) {
    for (let x = 0; x < n; x++) {
      cosTable[k * n + x] = Math.cos(((2 * x + 1) * k * Math.PI) / (2 * n))
    }
  }

  const tmp = new Float64Array(n * n)
  const out = new Float64Array(n * n)

  // 行变换
  for (let y = 0; y < n; y++) {
    for (let k = 0; k < n; k++) {
      let sum = 0
      for (let x = 0; x < n; x++) {
        sum += input[y * n + x] * cosTable[k * n + x]
      }
      tmp[y * n + k] = sum * (k === 0 ? Math.SQRT1_2 : 1)
    }
  }
  // 列变换
  for (let x = 0; x < n; x++) {
    for (let k = 0; k < n; k++) {
      let sum = 0
      for (let y = 0; y < n; y++) {
        sum += tmp[y * n + x] * cosTable[k * n + y]
      }
      out[k * n + x] = sum * (k === 0 ? Math.SQRT1_2 : 1)
    }
  }
  return out
}
