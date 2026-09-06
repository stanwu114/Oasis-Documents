import { readFile, stat } from 'node:fs/promises'
import { extname, basename } from 'node:path'
import { lookup } from 'mime-types'
import sharp from 'sharp'
import exifr from 'exifr'
import { sha256File } from '../organizer/hasher'
import { classifyExt, type FileCategory } from '../../shared/classify'

/* ================================================================
   内容提取器：文件 → (分类, 文本内容, 元数据, 缩略图)
   分类驱动：图片/视频（ffmpeg 抽帧）/svg 生成缩略图；文档提取全文
   ================================================================ */

export interface ExtractResult {
  category: FileCategory
  mimeType: string
  fileSize: number
  text: string
  meta: Record<string, unknown>
  thumbnailPath: string | null
  width?: number
  height?: number
}

/* R25：确认可按 UTF-8 安全读取全文的扩展名白名单——
   doc/ppt/xls/pages 等二进制 Office 格式无解析器，不伪装提取成功 */
const TEXT_SAFE_EXTS = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.yml', '.yaml', '.toml',
  '.ini', '.log', '.xml', '.html', '.htm', '.svg',
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.h', '.cpp', '.hpp', '.swift', '.sh', '.sql', '.css', '.scss', '.vue', '.php'
])

export async function extractContent(path: string, thumbnailsDir: string, prehashed?: string): Promise<ExtractResult> {
  const ext = extname(path).toLowerCase()
  const s = await stat(path)
  const mimeType = lookup(path) || 'application/octet-stream'
  const category = classifyExt(ext)

  if (category === 'image')
    return { ...(await extractImage(path, ext, s.size, mimeType, thumbnailsDir, prehashed)), category }
  if (category === 'video')
    return { ...(await extractVideo(path, s.size, mimeType, thumbnailsDir, prehashed)), category }
  if (ext === '.pdf') return withCat(extractPdf(path, s.size), 'document')
  if (ext === '.docx') return withCat(extractDocx(path, s.size), 'document')
  if (TEXT_SAFE_EXTS.has(ext)) return withCat(extractText(path, s.size, mimeType), 'document')
  if (category === 'document') {
    /* 二进制文档暂不支持全文：明确标记而非乱读乱码 */
    return {
      category,
      mimeType,
      fileSize: s.size,
      text: '',
      meta: { extractStatus: 'unsupported-fulltext' },
      thumbnailPath: null
    }
  }
  /* 图纸（无预览格式）/ 音频 / 其他：元信息入库 */
  return { category, mimeType, fileSize: s.size, text: '', meta: {}, thumbnailPath: null }
}

function withCat(p: Promise<Omit<ExtractResult, 'category'>>, category: FileCategory): Promise<ExtractResult> {
  return p.then((r) => ({ ...r, category }))
}

/* ---- 图片（含 HEIC 经 sips 桥接）：EXIF + 缩略图 ---- */
async function extractImage(
  path: string,
  ext: string,
  size: number,
  mimeType: string,
  thumbnailsDir: string,
  prehashed?: string
): Promise<Omit<ExtractResult, 'category'>> {
  const result: Omit<ExtractResult, 'category'> = { mimeType, fileSize: size, text: '', meta: {}, thumbnailPath: null }

  try {
    const { ensureDecodableImage } = await import('../image-decode')
    const decodable = await ensureDecodableImage(path)
    const meta = await sharp(decodable, { failOn: 'none' }).metadata()
    result.width = meta.width
    result.height = meta.height

    /* 缩略图：统一 480px 宽 JPEG（GIF 取首帧）；N01 哈希由调用方传入复用 */
    const hash = prehashed ?? (await sha256File(path))
    const thumbPath = `${thumbnailsDir}/${hash.slice(0, 16)}.jpg`
    try {
      await sharp(decodable, { failOn: 'none' })
        .rotate() /* 按 EXIF 方向摆正 */
        .resize({ width: 480, withoutEnlargement: true })
        .jpeg({ quality: 78 })
        .toFile(thumbPath)
      result.thumbnailPath = thumbPath
    } catch {
      /* 缩略图失败不影响索引 */
    }

    /* EXIF（jpg/heic/tiff 才有；EXIF 里的拍摄时间比文件 mtime 可靠） */
    if (ext === '.jpg' || ext === '.jpeg' || ext === '.tiff' || ext === '.heic') {
      try {
        const exif = await exifr.parse(path, { pick: ['DateTimeOriginal', 'Make', 'Model', 'GPSLatitude', 'GPSLongitude'] })
        if (exif) result.meta.exif = exif
      } catch {
        /* 无 EXIF 或解析失败 */
      }
    }
  } catch {
    /* 损坏图片：仅记录元信息 */
  }
  return result
}

/* ---- 视频：ffmpeg 抽第 1 秒帧为缩略图 ---- */
async function extractVideo(
  path: string,
  size: number,
  mimeType: string,
  thumbnailsDir: string,
  prehashed?: string
): Promise<Omit<ExtractResult, 'category'>> {
  const result: Omit<ExtractResult, 'category'> = { mimeType, fileSize: size, text: '', meta: {}, thumbnailPath: null }
  try {
    const hash = prehashed ?? (await sha256File(path))
    const thumbPath = `${thumbnailsDir}/${hash.slice(0, 16)}.jpg`
    const ffmpeg = (await import('ffmpeg-static')).default as string
    const { execFile } = await import('node:child_process')
    await new Promise<void>((resolve, reject) => {
      execFile(
        ffmpeg,
        ['-y', '-ss', '1', '-i', path, '-frames:v', '1', '-vf', 'scale=480:-2', thumbPath],
        { timeout: 20000 },
        (err) => (err ? reject(err) : resolve())
      )
    })
    result.thumbnailPath = thumbPath
  } catch {
    /* 抽帧失败：无缩略图，卡片显示占位 */
  }
  return result
}

/* ---- PDF：unpdf（完整 pdf.js，容错非标准 XRef）；
   扫描件（无文本层）渲染首页走 Vision OCR ---- */
async function extractPdf(path: string, size: number): Promise<Omit<ExtractResult, 'category'>> {
  try {
    const { extractText, getDocumentProxy } = await import('unpdf')
    const { readFile } = await import('node:fs/promises')
    const buf = new Uint8Array(await readFile(path))
    const pdf = await getDocumentProxy(buf)
    const { text, totalPages } = await extractText(pdf, { mergePages: true })
    const fullText = String(text ?? '').trim()

    if (fullText.length >= 20) {
      return {
        mimeType: 'application/pdf',
        fileSize: size,
        text: fullText,
        meta: { pages: totalPages },
        thumbnailPath: null
      }
    }

    /* 扫描件：文本层缺失 → 渲染首页 OCR（qlmanage 系统自带） */
    const ocrText = await ocrPdfFirstPage(path)
    return {
      mimeType: 'application/pdf',
      fileSize: size,
      text: ocrText,
      meta: { pages: totalPages, scanned: true, ocrPages: ocrText ? 1 : 0 },
      thumbnailPath: null
    }
  } catch (err) {
    return degraded('application/pdf', size, err)
  }
}

/** 扫描 PDF 首页 → qlmanage 渲染 PNG → Vision OCR */
async function ocrPdfFirstPage(path: string): Promise<string> {
  if (process.platform !== 'darwin') return ''
  try {
    const { execFile } = await import('node:child_process')
    const { mkdtemp, readdir } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'pdf-ocr-'))
    await new Promise<void>((resolve, reject) => {
      execFile('qlmanage', ['-t', '-s', '1600', '-o', dir, path], { timeout: 20000 }, (e) => (e ? reject(e) : resolve()))
    })
    const files = await readdir(dir)
    const png = files.find((f) => f.endsWith('.png'))
    if (!png) return ''
    const { ocrImage } = await import('../ocr')
    const text = await ocrImage(join(dir, png))
    const { rm } = await import('node:fs/promises')
    void rm(dir, { recursive: true, force: true }).catch(() => {})
    return text
  } catch {
    return ''
  }
}

/* ---- Word: mammoth 优先；失败（WPS 等非标 docx）→ unzip 剥 XML 兜底 ---- */
async function extractDocx(path: string, size: number): Promise<Omit<ExtractResult, 'category'>> {
  try {
    const mod = (await import('mammoth')) as { extractRawText: (o: { path: string }) => Promise<{ value: string }> }
    const { value } = await mod.extractRawText({ path })
    return { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileSize: size, text: value, meta: {}, thumbnailPath: null }
  } catch {
    /* 兜底：docx 是 zip 容器，unzip 取 word/document.xml 剥标签（系统自带，零依赖） */
    try {
      const { execFile } = await import('node:child_process')
      const xml = await new Promise<string>((resolve, reject) => {
        execFile('unzip', ['-p', path, 'word/document.xml'], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, (e, out) =>
          e ? reject(e) : resolve(String(out))
        )
      })
      const text = xml
        .replace(/<w:p[^>]*>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
      if (text.length > 0) {
        return { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileSize: size, text, meta: { extractor: 'unzip-fallback' }, thumbnailPath: null }
      }
      throw new Error('unzip 兜底也未提取到文本')
    } catch (err) {
      return degraded('application/octet-stream', size, err)
    }
  }
}

/* ---- 纯文本类 ---- */
async function extractText(path: string, size: number, mimeType: string): Promise<Omit<ExtractResult, 'category'>> {
  const handle = await import('node:fs/promises').then((m) => m.open(path, 'r'))
  try {
    /* R25 兜底：二进制嗅探——前 4KB 含 NUL 字节即非文本，不产生乱码 */
    const probe = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(probe, 0, 4096, 0)
    if (probe.slice(0, bytesRead).includes(0)) {
      return {
        mimeType,
        fileSize: size,
        text: '',
        meta: { extractStatus: 'binary-detected' },
        thumbnailPath: null
      }
    }
  } finally {
    await handle.close()
  }
  const buf = await readFile(path)
  return {
    mimeType,
    fileSize: size,
    text: buf.toString('utf8').slice(0, 2_000_000), /* 超大文本截断 */
    meta: { lines: buf.toString('utf8').split('\n').length },
    thumbnailPath: null
  }
}

function degraded(mimeType: string, size: number, err: unknown): Omit<ExtractResult, 'category'> {
  const reason = err instanceof Error ? err.message : String(err)
  return {
    mimeType,
    fileSize: size,
    text: '',
    meta: { extractError: reason.slice(0, 300) },
    thumbnailPath: null
  }
}

/** 从文件名推断标题（去扩展名、替换下划线连字符） */
export function titleFromPath(path: string): string {
  return basename(path, extname(path)).replace(/[_-]+/g, ' ').trim() || basename(path)
}
