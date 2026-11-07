import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderCampaignMessage, validateTemplate } from '../../../src/domain/campaigns/template.js';

const FOOTER = 'Responde SAIR para sair desta lista.';
const cfg = { optOutFooter: FOOTER };

describe('campaign template', () => {
  it('valida variáveis no boundary', () => {
    assert.doesNotThrow(() => validateTemplate('Olá {{nome}}, temos novidades.'));
    assert.doesNotThrow(() => validateTemplate('Olá {{primeiro_nome}}!'));
    assert.throws(() => validateTemplate('Olá {{apelido}}'), /unknown_variable \{\{apelido\}\}/);
    assert.doesNotThrow(() => validateTemplate('Olá {{ nome }}'));
    assert.throws(() => validateTemplate('Olá {{nome'), /malformed_variable/);
    assert.throws(() => validateTemplate('   '), /empty_template/);
  });

  it('renderiza variáveis e anexa sempre o rodapé de opt-out', () => {
    assert.equal(
      renderCampaignMessage({ template: 'Olá {{nome}}!', contactName: '  Ana Maria  ' }, cfg),
      `Olá Ana Maria!\n\n${FOOTER}`,
    );
    assert.equal(
      renderCampaignMessage({ template: 'Olá {{primeiro_nome}}!', contactName: 'Ana Maria' }, cfg),
      `Olá Ana!\n\n${FOOTER}`,
    );
    assert.equal(
      renderCampaignMessage({ template: 'Oi {{nome}}', contactName: null }, cfg),
      `Oi \n\n${FOOTER}`,
    );
    const already = `Oi {{nome}}\n\n${FOOTER}`;
    assert.equal(
      renderCampaignMessage({ template: already, contactName: 'Ana' }, cfg),
      `Oi Ana\n\n${FOOTER}`,
    ); // não duplica o rodapé
  });
});
