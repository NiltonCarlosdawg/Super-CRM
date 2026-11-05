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

test('extractDocument extrai texto de um PDF real (pdfjs recebe Uint8Array)', async () => {
  const content = 'BT /F1 18 Tf 72 700 Td (Instalacao CCTV 250 euros) Tj ET';
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    `<</Length ${Buffer.byteLength(content)}>>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;

  const result = await extractDocument(Buffer.from(pdf, 'latin1'), 'application/pdf', { ocrEnabled: false });
  assert.match(result.text, /Instalacao CCTV 250 euros/);
});
