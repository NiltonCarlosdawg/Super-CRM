// Rótulos PT-AO partilhados (Task 5 cria os de papel; T7/T8/T9/T11 acrescentam
// os seus aqui — um sítio só para a copy de estados, testado por tarefa).

import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import {
  OWN_PASSWORD_SESSIONS_WARNING,
  RESET_PASSWORD_SESSIONS_WARNING,
  TOTP_DISABLE_NOTE,
  passwordChangeErrorText,
  roleLabel,
  totpErrorText,
} from "./labels";

describe("roleLabel", () => {
  it("traduz os três papéis para PT-AO", () => {
    expect(roleLabel("admin")).toBe("Administrador");
    expect(roleLabel("editor")).toBe("Editor");
    expect(roleLabel("agent")).toBe("Agente");
  });
});

// Onda 1, Task 11 — Definições e reposição de password
describe("copy de Definições/repo (Task 11)", () => {
  it("nota honesta de TOTP: sem desactivação, falar com suporte", () => {
    expect(TOTP_DISABLE_NOTE).toMatch(/desactivar o TOTP não está disponível/i);
    expect(TOTP_DISABLE_NOTE).toMatch(/contacte o suporte/i);
  });

  it("avisos de sessões distinguem a password própria (actual mantém-se) da repo (todas)", () => {
    expect(OWN_PASSWORD_SESSIONS_WARNING).toMatch(/sessões/);
    expect(OWN_PASSWORD_SESSIONS_WARNING).toMatch(/actual mantém-se/);
    expect(RESET_PASSWORD_SESSIONS_WARNING).toMatch(/sessões/);
    expect(RESET_PASSWORD_SESSIONS_WARNING).not.toMatch(/actual mantém-se/);
  });

  it("passwordChangeErrorText mapeia códigos e cai no detail do backend", () => {
    expect(passwordChangeErrorText(new ApiError(401, "invalid_credentials"))).toBe(
      "A palavra-passe actual está incorrecta",
    );
    expect(passwordChangeErrorText(new ApiError(400, "weak_password"))).toMatch(/12 caracteres/);
    expect(passwordChangeErrorText(new ApiError(500, "erro", "boom"))).toBe("boom");
    expect(passwordChangeErrorText(new Error("rede"))).toBe("Erro inesperado");
  });

  it("totpErrorText mapeia código inválido e rede", () => {
    expect(totpErrorText(new ApiError(400, "invalid_code"))).toBe("Código inválido — tenta de novo");
    expect(totpErrorText(new ApiError(0, "network"))).toBe("Sem ligação ao servidor");
  });
});
