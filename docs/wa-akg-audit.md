## 0. Origem e método
- Repositório upstream: https://github.com/mrifqidaffaaditya/WA-AKG (MIT)
- Fork nosso: https://github.com/NiltonCarlosdawg/WA-AKG
- Commit auditado: c7dd01a04339e4363b549beb3a41fe02cf131acb  (branch: main)
- Data da auditoria: 2026-10-08
- Comandos de referência: git clone --no-tags https://github.com/NiltonCarlosdawg/WA-AKG /home/niltoncosta/Documentos/Projetos/Milvendas/WA-AKG ; git -C ../WA-AKG rev-parse HEAD
- Método: análise estática (leitura + grep); execução do código do fork SÓ com `npm ci --ignore-scripts` e para as perguntas G20/G17, em clone descartável
- Imutabilidade: `git -C ../WA-AKG status --porcelain` vazio após a auditoria
- Nenhum segredo encontrado é transcribo sem mascaramento (`***`)
