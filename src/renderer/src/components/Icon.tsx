/* 内联 SVG 图标（线条风格，与 Meeting 一致） */

const PATHS: Record<string, string> = {
  search: 'M10 4a6 6 0 104.47 10.03l4.25 4.25 1.41-1.41-4.25-4.25A6 6 0 0010 4zm0 2a4 4 0 110 8 4 4 0 010-8z',
  broom: 'M14 3l7 7-2 2-7-7 2-2zM9 8l7 7-6 6H4v-6l5-7z M4 14l6 6',
  files: 'M4 4a2 2 0 012-2h5l2 2h7a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4z',
  rss: 'M4 11a9 9 0 019 9M4 4a16 16 0 0116 16 M6 17a2 2 0 100 4 2 2 0 000-4z',
  settings: 'M12 8a4 4 0 100 8 4 4 0 000-8zm9 4c0 .5 0 1-.1 1.4l2 1.6-2 3.4-2.4-1a7 7 0 01-2.4 1.4L15.7 21h-4l-.4-2.6a7 7 0 01-2.4-1.4l-2.4 1-2-3.4 2-1.6C6 13 6 12.5 6 12s0-1 .1-1.4l-2-1.6 2-3.4 2.4 1a7 7 0 012.4-1.4L11.7 3h4l.4 2.6a7 7 0 012.4 1.4l2.4-1 2 3.4-2 1.6c.1.4.1.9.1 1.4z',
  trash: 'M6 7h12l-1 13a2 2 0 01-2 2H9a2 2 0 01-2-2L6 7zm3-4h6l1 2H8l1-2z',
  sun: 'M12 17a5 5 0 100-10 5 5 0 000 10zm0-15v2m0 18v2M4.2 4.2l1.4 1.4m12.8 12.8l1.4 1.4M2 12h2m18 0h-2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M20 14A8 8 0 019 3a8 8 0 1011 11z',
  image: 'M4 5h16v14H4V5zm2 10l3.5-4 2.5 3 3-4L18 16H6zm2.5-5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z',
  doc: 'M6 2h8l4 4v16H6V2zm8 0v4h4M9 12h6M9 16h6',
  file: 'M6 2h8l4 4v16H6V2zm8 0v4h4',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z',
  undo: 'M9 14l-5-5 5-5 M4 9h10a6 6 0 010 12h-3',
  folder: 'M3 6h6l2 2h10v11H3V6z',
  close: 'M6 6l12 12M18 6L6 18'
}

export function Icon({ name, size = 15 }: { name: keyof typeof PATHS | string; size?: number }): React.ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name] ?? PATHS.file} />
    </svg>
  )
}
