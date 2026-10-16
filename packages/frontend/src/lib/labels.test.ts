// Rótulos PT-AO partilhados (Task 5 cria os de papel; T7/T8/T9/T11 acrescentam
// os seus aqui — um sítio só para a copy de estados, testado por tarefa).

import { describe, expect, it } from "vitest";
import { roleLabel } from "./labels";

describe("roleLabel", () => {
  it("traduz os três papéis para PT-AO", () => {
    expect(roleLabel("admin")).toBe("Administrador");
    expect(roleLabel("editor")).toBe("Editor");
    expect(roleLabel("agent")).toBe("Agente");
  });
});
