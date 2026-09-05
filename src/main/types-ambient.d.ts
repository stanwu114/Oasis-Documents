/* 无类型声明的 CommonJS 依赖 */
declare module 'pdf-parse' {
  const pdfParse: (buffer: Buffer) => Promise<{ text: string; numpages: number }>
  export default pdfParse
}
