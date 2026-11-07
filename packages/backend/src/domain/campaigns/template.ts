// Fase 4, Task 4: variáveis do modelo e rodapé de opt-out.
// O rodapé entra SEMPRE na renderização (docs/03 §8), mesmo que o modelo se
// esqueça dele; a validação corre na criação da campanha (boundary).

import type { CampaignConfig } from '../../modules/campaigns/config.js';

export const CAMPAIGN_VARIABLES = ['nome', 'primeiro_nome'] as const;
export type TemplateErrorCode = 'unknown_variable' | 'malformed_variable' | 'empty_template';

export class TemplateError extends Error {
  readonly code: TemplateErrorCode;

  constructor(code: TemplateErrorCode, detail: string) {
    super(`${code} ${detail}`);
    this.name = 'TemplateError';
    this.code = code;
  }
}

const VARIABLE = /\{\{\s*([a-z_]+)\s*\}\}/g;

export function validateTemplate(template: string): void {
  if (template.trim() === '') throw new TemplateError('empty_template', '(modelo vazio)');
  for (const match of template.matchAll(VARIABLE)) {
    const key = match[1]!;
    if (!(CAMPAIGN_VARIABLES as readonly string[]).includes(key)) {
      throw new TemplateError('unknown_variable', `{{${key}}}`);
    }
  }
  if (template.replace(VARIABLE, '').includes('{{')) {
    throw new TemplateError('malformed_variable', '(variável sem fecho válido)');
  }
}

export function renderCampaignMessage(
  input: { template: string; contactName: string | null },
  cfg: Pick<CampaignConfig, 'optOutFooter'>,
): string {
  const name = (input.contactName ?? '').trim();
  const firstName = name.split(/\s+/)[0] ?? '';
  const rendered = input.template
    .replace(/\{\{\s*nome\s*\}\}/g, name)
    .replace(/\{\{\s*primeiro_nome\s*\}\}/g, firstName);
  return rendered.includes(cfg.optOutFooter) ? rendered : `${rendered}\n\n${cfg.optOutFooter}`;
}
