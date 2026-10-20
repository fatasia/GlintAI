declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfResult {
    numpages: number;
    text: string;
  }
  function pdfParse(buffer: Buffer): Promise<PdfResult>;
  export = pdfParse;
}
