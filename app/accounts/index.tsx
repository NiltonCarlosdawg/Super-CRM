import AccountCard from "@/components/AccountCard";
import RhythmWarning from "@/components/RhythmWarning";

export function AccountsIndex() {
  // Dados mock - em produção vieram do backend via API
  const contas = [
    {
      id: "acc-1",
      nome: "Conta WhatsApp - Vendas",
      status: "online",
      ultimaMensagem: "14:32",
      mensagensHoje: 842,
      limite: 1000,
      permissoes: ["enviar", "receber", "campanhas"],
    },
    {
      id: "acc-2",
      nome: "Conta WhatsApp - Suporte",
      status: "limited",
      ultimaMensagem: "13:15",
      mensagensHoje: 950,
      limite: 1000,
      permissoes: ["receber"],
    },
  ];

  return (
    <div className="bg-card rounded-lg shadow-sm p-6">
      <h2 className="font-serif font-medium text-lg mb-6">Minhas Contas WhatsApp</h2>

      < RhythmWarning />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* Conta 1: Vendas */}
        <AccountCard
          id="acc-1"
          nome="Conta WhatsApp - Vendas"
          status="online"
          ultimaMensagem="14:32"
          mensagensHoje={842}
          limite={1000}
          permissoes={["enviar", "receber", "campanhas"]}
        />

        {/* Conta 2: Suporte */}
        <AccountCard
          id="acc-2"
          nome="Conta WhatsApp - Suporte"
          status="limited"
          ultimaMensagem="13:15"
          mensagensHoje={950}
          limite={1000}
          permissoes={["receber"]}
        />
      </div>

      {/* Botão Conectar Nova Conta */}
      <a href="/accounts/connect" className="mt-4 inline-block">
        <svg
          className="w-5 h-5 inline mr-1"
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path d="M9 5l-4 4 1.41 1.41L11 9l4-4-1.41-1.41z" />
          <path d="M15 5l-4 4 1.41 1.41L16 9l4-4-1.41-1.41z" />
        </svg>
        Conectar nova conta
      </a>
    </div>
  );
}