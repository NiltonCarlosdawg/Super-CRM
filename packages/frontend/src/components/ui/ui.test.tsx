// Primitivas de UI (Task 4 do plano do frontend): variantes do Button, erro
// acessível no Field, Badge sempre com texto, Toast com dismiss e fumos dos
// restantes. São as classes das variantes que se testam — é o contrato visual.

import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Card } from "./Card";
import { EmptyState } from "./EmptyState";
import { Field } from "./Field";
import { Modal } from "./Modal";
import { Spinner } from "./Spinner";
import { ToastProvider, useToast } from "./Toast";

describe("Button", () => {
  it("solido usa o estilo primary e type=button por omissão", () => {
    render(<Button variant="solid">Enviar</Button>);

    const button = screen.getByRole("button", { name: "Enviar" });
    expect(button).toHaveAttribute("type", "button");
    expect(button.className).toContain("bg-accent");
  });
});

describe("Field", () => {
  it("mostra o error com aria-invalid", () => {
    render(<Field label="Email" error="Obrigatório" />);

    const input = screen.getByLabelText("Email");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Obrigatório")).toHaveAttribute("role", "alert");
  });
});

describe("Badge", () => {
  it("renderiza texto + icone (nunca só cor)", () => {
    render(
      <Badge tone="warning" icon={<span data-testid="badge-icon">●</span>}>
        A ligar
      </Badge>,
    );

    expect(screen.getByText("A ligar")).toBeInTheDocument();
    expect(screen.getByTestId("badge-icon")).toBeInTheDocument();
  });
});

describe("Toast", () => {
  it("mostra mensagem e some no dismiss", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ToastProvider>{children}</ToastProvider>
    );
    const { result } = renderHook(() => useToast(), { wrapper });

    act(() => result.current.show("Guardado"));
    expect(screen.getByText("Guardado")).toBeInTheDocument();

    act(() => result.current.error("Falhou o envio"));
    expect(screen.getByText("Falhou o envio")).toBeInTheDocument();

    fireEvent.click(screen.getAllByLabelText("Fechar aviso")[0]);
    expect(screen.queryByText("Guardado")).toBeNull();
    expect(screen.getByText("Falhou o envio")).toBeInTheDocument();
  });
});

describe("Card / Spinner / EmptyState", () => {
  it("Card renderiza filhos em superfície", () => {
    render(<Card>conteúdo</Card>);
    const card = screen.getByText("conteúdo");
    expect(card.className).toContain("bg-surface");
    expect(card.className).toContain("border-border");
  });

  it("Spinner é um status acessível", () => {
    render(<Spinner />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("EmptyState mostra título e descrição", () => {
    render(<EmptyState title="Sem dados" description="Ainda nada por aqui" />);
    expect(screen.getByText("Sem dados")).toBeInTheDocument();
    expect(screen.getByText("Ainda nada por aqui")).toBeInTheDocument();
  });
});

describe("Modal", () => {
  it("aberto mostra o diálogo e o Fechar chama onClose", () => {
    const onClose = vi.fn();
    render(
      <Modal open title="Criar conta" onClose={onClose}>
        formulário
      </Modal>,
    );

    expect(screen.getByRole("dialog")).toHaveTextContent("Criar conta");
    fireEvent.click(screen.getByLabelText("Fechar"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("fechado não renderiza nada", () => {
    render(
      <Modal open={false} title="Criar conta" onClose={() => undefined}>
        formulário
      </Modal>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
