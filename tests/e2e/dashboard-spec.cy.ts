describe("Dashboard Critical Path", () => {
  beforeEach(() => {
    // Fazer login antes de cada teste
    cy.visit("/auth/login");
    cy.contains("Entrar").click();
    // Simular login bem-sucedido - em produção seria via API
    cy.url().should("include", "/dashboard");
  });

  it("deve carregar dashboard com estatísticas", () => {
    cy.contains("Fila de Conversas").should("exist");
    cy.contains("Contas Ativas").should("exist");
    cy.contains("Campanhas Rodando").should("exist");
  });

  it("deve exibir aviso de limite quando próximo", () => {
    // O aviso deve aparecer quando próximo do limite (configurado no TopCards)
    cy.contains("Próximo do limite").should("exist");
  });

  it("deve permitir filtrar conversas", () => {
    // Filtros devem estar disponíveis
    cy.contains("Filtrar").should("exist");
  });

  it("deve permitir handoff de conversa", () => {
    // Botão handoff deve estar visível
    cy.contains("Passar para humano").should("exist");
  });
});