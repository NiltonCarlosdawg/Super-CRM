describe("Handoff Critical Path", () => {
  beforeEach(() => {
    cy.visit("/auth/login");
    cy.contains("Entrar").click();
    cy.url().should("include", "/dashboard");
  });

  it("deve exibir badge de IA na conversa", () => {
    cy.contains("🤖").should("exist");
  });

  it("deve passar conversa para humano", () => {
    // Clicar no botão handoff
    cy.contains("Passar para humano").click();
    // Verificar que o status mudou
    cy.contains("Aguardando humano").should("exist");
  });

  it("deve permitir entrar na conversa humana", () => {
    // Após handoff, botão "Entrar na conversa" deve aparecer
    cy.contains("Entrar na conversa").should("exist");
  });
});