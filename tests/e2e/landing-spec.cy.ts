describe("Landing Page Critical Path", () => {
  beforeEach(() => {
    // Visitar a landing page antes de cada teste
    cy.visit("/");
  });

  it("deve exibir hero section e CTA", () => {
    cy.contains("Gestão de WhatsApp para Telecomunicações").should("exist");
    cy.contains("Começar grátis").should("exist");
  });

  it("deve navegar para cadastro ao clicar em CTA", () => {
    cy.contains("Começar grátis").click();
    cy.url().should("include", "/auth/register");
  });
});