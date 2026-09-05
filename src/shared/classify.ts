/* 统一文件分类：图片 / 视频 / 图纸 / 音频 / 文档 / 其他 */

export type FileCategory = 'image' | 'video' | 'drawing' | 'audio' | 'document' | 'other'

export const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'tif', 'heic', 'avif', 'svg'])
/* 注：'ts' 不列入视频（TypeScript 代码远比 MPEG-TS 常见）；
   MPEG-TS 视频如需支持，后续按内容检测区分 */
export const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'm4v', 'wmv', 'mpg', 'mpeg', 'rmvb'])
export const DRAWING_EXTS = new Set([
  'dwg', 'dxf', 'dwf', 'dwt', 'ifc', 'rvt', 'rfa', 'skp',
  'eps', 'ai', 'cdr', 'plt', 'stl', 'obj', '3ds', 'max', 'blend', 'fbx',
  'step', 'stp', 'iges', 'igs'
])
export const AUDIO_EXTS = new Set(['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a', 'wma', 'aiff', 'opus', 'mid'])
export const DOC_EXTS = new Set([
  'pdf', 'docx', 'doc', 'txt', 'md', 'markdown', 'rtf', 'pages',
  'pptx', 'ppt', 'key', 'xlsx', 'xls', 'numbers', 'csv', 'tsv',
  'json', 'yaml', 'yml', 'toml', 'log', 'html', 'htm', 'xml',
  'ts', 'tsx', 'js', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'swift', 'sh', 'sql',
  'wps', 'et', 'ett', 'dps', 'dpt', 'wpt'
])

export function classifyExt(ext: string): FileCategory {
  const e = ext.toLowerCase().replace(/^\./, '')
  if (IMAGE_EXTS.has(e)) return 'image'
  if (VIDEO_EXTS.has(e)) return 'video'
  if (DRAWING_EXTS.has(e)) return 'drawing'
  if (AUDIO_EXTS.has(e)) return 'audio'
  if (DOC_EXTS.has(e)) return 'document'
  return 'other'
}

export const CATEGORY_LABEL: Record<FileCategory, string> = {
  image: '图片',
  video: '视频',
  drawing: '图纸',
  audio: '音频',
  document: '文档',
  other: '其他'
}

/** 瀑布流卡片展示的三类（其余用列表） */
export const MASONRY_CATEGORIES: FileCategory[] = ['image', 'video', 'drawing']
