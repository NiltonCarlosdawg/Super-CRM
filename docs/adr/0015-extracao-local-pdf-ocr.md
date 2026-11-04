# ADR-0015 — Extracção local de PDF e OCR

## Contexto

A Fase 2 precisa aceitar PDF, imagens e PDF digitalizado sem enviar documentos
para serviços externos. A rota HTTP não deve executar trabalho pesado nem manter
bytes depois da extracção.

## Decisão

Usar `pdfjs-dist` para texto/rasterização, `@napi-rs/canvas` para páginas e
`tesseract.js` para OCR local `por+eng`. A rota grava bytes em
`knowledge_train_uploads.content` e agenda `knowledge.extract`; o job extrai,
limita páginas/caracteres e limpa `content` em sucesso ou erro.

Flags e limites são configuráveis: OCR ligado por defeito, 10 MiB por ficheiro,
25 MiB por pedido, 20 páginas e timeout de 120 s. MIME declarado nunca substitui
a validação dos magic bytes.

## Alternativas rejeitadas

- OCR externo: risco de privacidade e conflito com ADR-0002.
- `tesseract` do sistema: não está garantido no cPanel partilhado.
- DOCX: fora do âmbito da Fase 2.

## Consequências

Há consumo local de RAM/CPU e é necessário cache dos dados WASM. Com OCR
desligado, imagens/PDF sem texto falham de forma explícita; TXT/MD continuam
disponíveis.
