// Extracção local da Task 7. Interfaces injectáveis mantêm os testes sem
// downloads WASM; o adaptador real usa pdfjs/canvas/tesseract apenas no job.
import { createCanvas } from '@napi-rs/canvas';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createWorker } from 'tesseract.js';

// pdfjs recusa Buffer e avisa quando os tipos de letra padrão não estão disponíveis
// (páginas digitalizadas renderizam em branco sem eles).
const PDFJS_DIR = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const STANDARD_FONTS_URL = join(PDFJS_DIR, 'standard_fonts') + '/';

export type ExtractErrorCode = 'pdf_invalid' | 'pdf_without_text' | 'ocr_disabled' | 'ocr_failed' | 'ocr_timeout' | 'document_too_large';
export class DocumentExtractError extends Error { constructor(readonly code: ExtractErrorCode) { super(code); this.name = 'DocumentExtractError'; } }

export interface DocumentExtractorOptions {
  ocrEnabled?: boolean;
  maxPages?: number;
  maxChars?: number;
  timeoutMs?: number;
  ocrLangs?: string;
  /** Onde o tesseract guarda os `*.traineddata`; por omissão `OCR_CACHE_DIR`. */
  ocrCacheDir?: string;
}

const useful = (text: string): string => text.replace(/\s+/g, ' ').trim();
const has = (value: Buffer, bytes: number[]): boolean => bytes.every((b, i) => value[i] === b);
const validImage = (content: Buffer): boolean =>
  has(content, [0xff, 0xd8, 0xff]) || has(content, [0x89, 0x50, 0x4e, 0x47]) || has(content, [0x52, 0x49, 0x46, 0x46]) && content.subarray(8, 12).toString() === 'WEBP';

async function ocrImage(content: Buffer, opts: Required<DocumentExtractorOptions>): Promise<string> {
  if (!opts.ocrEnabled) throw new DocumentExtractError('ocr_disabled');
  const worker = await createWorker(opts.ocrLangs, undefined, { cachePath: opts.ocrCacheDir });
  try {
    const result = await Promise.race([
      worker.recognize(content),
      new Promise<never>((_, reject) => setTimeout(() => reject(new DocumentExtractError('ocr_timeout')), opts.timeoutMs)),
    ]);
    return useful(result.data.text);
  } catch (error) {
    if (error instanceof DocumentExtractError) throw error;
    throw new DocumentExtractError('ocr_failed');
  } finally {
    await worker.terminate();
  }
}

export async function extractDocument(content: Buffer, mediaType: string, options: DocumentExtractorOptions = {}): Promise<{ text: string }> {
  const opts: Required<DocumentExtractorOptions> = { ocrEnabled: options.ocrEnabled ?? process.env.OCR_ENABLED !== 'false', maxPages: options.maxPages ?? Number(process.env.DOCUMENT_MAX_PAGES ?? 20), maxChars: options.maxChars ?? 1_000_000, timeoutMs: options.timeoutMs ?? Number(process.env.OCR_TIMEOUT_MS ?? 120_000), ocrLangs: options.ocrLangs ?? process.env.OCR_LANGS ?? 'por+eng', ocrCacheDir: options.ocrCacheDir ?? process.env.OCR_CACHE_DIR ?? '.cache/tesseract' };
  let text = '';
  if (mediaType === 'application/pdf') {
    if (!has(content, [0x25, 0x50, 0x44, 0x46, 0x2d])) throw new DocumentExtractError('pdf_invalid');
    let pdf;
    try { pdf = await getDocument({ data: new Uint8Array(content), standardFontDataUrl: STANDARD_FONTS_URL }).promise; } catch { throw new DocumentExtractError('pdf_invalid'); }
    if (pdf.numPages > opts.maxPages) throw new DocumentExtractError('document_too_large');
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
      const page = await pdf.getPage(pageNo);
      const items = await page.getTextContent();
      const pageText = useful(items.items.map((item) => ('str' in item ? item.str : '')).join(' '));
      if (pageText.length >= 20) text += `${pageText}\n`;
      else {
        if (!opts.ocrEnabled) throw new DocumentExtractError('pdf_without_text');
        const viewport = page.getViewport({ scale: 150 / 72 });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext('2d');
        await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise;
        text += `${await ocrImage(canvas.toBuffer('image/png'), opts)}\n`;
      }
    }
  } else if (mediaType.startsWith('image/')) {
    if (!validImage(content)) throw new DocumentExtractError('ocr_failed');
    text = await ocrImage(content, opts);
  } else {
    text = content.toString('utf8');
  }
  text = text.trim();
  if (text.length > opts.maxChars) throw new DocumentExtractError('document_too_large');
  if (text.length === 0) throw new DocumentExtractError('pdf_without_text');
  return { text };
}
