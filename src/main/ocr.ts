import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getMediaDir } from './dataLocation'

/* ================================================================
   F02 OCR：macOS 系统级 Vision 桥接（零依赖、支持中文+HEIC）
   首次调用编译 swift 脚本为二进制（缓存于媒体目录），此后直接执行
   ================================================================ */

const SWIFT_SRC = `import Vision
import AppKit

let path = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile: path),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  print("")
  exit(0)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try handler.perform([request])

let lines = (request.results ?? []).compactMap { obs in
  obs.topCandidates(1).first?.string
}
print(lines.joined(separator: "\\n"))
`

let binaryPath: string | null = null
let compilePromise: Promise<string> | null = null

function getOcrBinary(): Promise<string> {
  if (binaryPath && existsSync(binaryPath)) return Promise.resolve(binaryPath)
  if (compilePromise) return compilePromise
  const dir = join(getMediaDir(), 'ocr')
  mkdirSync(dir, { recursive: true })
  const src = join(dir, 'ocr.swift')
  const bin = join(dir, 'ocr-bin')
  if (!existsSync(src)) writeFileSync(src, SWIFT_SRC)
  compilePromise = new Promise<string>((resolve, reject) => {
    if (existsSync(bin)) {
      binaryPath = bin
      resolve(bin)
      return
    }
    execFile('swiftc', ['-O', src, '-o', bin], { timeout: 120_000 }, (err) => {
      if (err) {
        reject(new Error(`OCR 编译失败: ${err.message}`))
        compilePromise = null
        return
      }
      binaryPath = bin
      resolve(bin)
    })
  })
  return compilePromise
}

/** 对单张图片执行 OCR（HEIC 先经 sips 转 JPEG），返回识别文本 */
export async function ocrImage(imagePath: string): Promise<string> {
  if (process.platform !== 'darwin') return ''
  try {
    const { ensureDecodableImage } = await import('./image-decode')
    const decodable = await ensureDecodableImage(imagePath)
    const bin = await getOcrBinary()
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(bin, [decodable], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) =>
        err ? reject(err) : resolve(String(out))
      )
    })
    return stdout.trim()
  } catch (e) {
    console.warn('[ocr] 失败:', e instanceof Error ? e.message : e)
    return ''
  }
}

/** OCR 是否可用（macOS 且 swiftc 存在） */
export function ocrAvailable(): boolean {
  return process.platform === 'darwin'
}
