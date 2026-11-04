import assert from 'node:assert/strict';
import test from 'node:test';
import { DocumentExtractError, extractDocument } from '../../src/modules/knowledge/document-extractor.js';

test('extractDocument mantém texto simples sem OCR', async () => {
  const result = await extractDocument(Buffer.from('Política sintética.'), 'text/plain');
  assert.equal(result.text, 'Política sintética.');
});

test('extractDocument rejeita PDF sem magic bytes', async () => {
  await assert.rejects(
    extractDocument(Buffer.from('não é pdf'), 'application/pdf'),
    (error: unknown) => error instanceof DocumentExtractError && error.code === 'pdf_invalid',
  );
});

test('extractDocument rejeita imagem sem OCR quando o kill-switch está desligado', async () => {
  await assert.rejects(
    extractDocument(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png', { ocrEnabled: false }),
    (error: unknown) => error instanceof DocumentExtractError && error.code === 'ocr_disabled',
  );
});
