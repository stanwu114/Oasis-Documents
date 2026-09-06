/* 无类型声明的 CommonJS 依赖 */
declare module 'pdf-parse' {
  const pdfParse: (buffer: Buffer) => Promise<{ text: string; numpages: number }>
  export default pdfParse
}

declare module 'mailparser' {
  export interface ParsedMail {
    subject?: string
    text?: string
    html?: string | false
    from?: { text?: string }
    date?: Date
    messageId?: string
  }
  export function simpleParser(source: Buffer | string): Promise<ParsedMail>
}
