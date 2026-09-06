import { embeddedState, httpUrl } from './page-data'

interface XhsNote {
  noteId?: string
  title?: string
  desc?: string
  type?: string
  user?: { nickname?: string }
  tagList?: { name?: string }[]
  imageList?: { urlDefault?: string; url?: string; infoList?: { imageScene?: string; url?: string }[] }[]
  video?: { media?: { stream?: Record<string, { masterUrl?: string; master_url?: string; backupUrls?: string[]; backup_urls?: string[] }[]> } }
}

export function extractXhsNote(html: string, noteId?: string): XhsNote | null {
  const state = embeddedState(html, '__INITIAL_STATE__') as {
    note?: { currentNoteId?: string; noteDetailMap?: Record<string, { note?: XhsNote } & XhsNote>; noteMap?: Record<string, { note?: XhsNote } & XhsNote> }
  } | null
  const section = state?.note
  const map = section?.noteDetailMap ?? section?.noteMap
  if (!map) return null
  const key = noteId ?? section?.currentNoteId ?? Object.keys(map)[0]
  const entry = key ? map[key] : undefined
  const note = entry?.note ?? entry
  return note && (note.title || note.desc || note.imageList?.length || note.video) ? note : null
}

export function xhsMedia(note: XhsNote): { imageUrls: string[]; videoUrl?: string } {
  const imageUrls = (note.imageList ?? []).map((image) => {
    const preferred = image.infoList?.find((i) => i.imageScene === 'WB_DFT')
    return httpUrl(preferred?.url) ?? httpUrl(image.urlDefault) ?? httpUrl(image.url) ??
      image.infoList?.map((i) => httpUrl(i.url)).find(Boolean)
  }).filter((u): u is string => Boolean(u))
  const stream = note.video?.media?.stream
  for (const codec of ['h264', 'h265', 'av1']) {
    for (const item of stream?.[codec] ?? []) {
      const videoUrl = httpUrl(item.masterUrl ?? item.master_url) ?? httpUrl(item.backupUrls?.[0] ?? item.backup_urls?.[0])
      if (videoUrl) return { imageUrls, videoUrl }
    }
  }
  return { imageUrls }
}
