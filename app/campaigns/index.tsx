import CampaignCard from "@/components/CampaignCard";

export function CampaignsIndex() {
  // Dados mock - em produção vieram do backend via API
  const campanhas = [
    {
      id: "camp-1",
      nome: "Black Friday Teleco",
      status: "running",
      mensagensEnviadas: 1247,
      limite: 2000,
      criadoEm: "20/11/2024",
    },
    {
      id: "camp-2",
      nome: "Novo Catálogo - Outono",
      status: "paused",
      mensagensEnviadas: 342,
      limite: 5000,
      criadoEm: "05/11/2024",
    },
    {
      id: "camp-3",
      nome: "Aniversário Clients",
      status: "finished",
      mensagensEnviadas: 500,
      limite: 500,
      criadoEm: "10/10/2024",
    },
  ];

  return (
    <div className="bg-card rounded-lg shadow-sm p-6">
      <h2 className="font-serif font-medium text-lg mb-6">Minhas Campanhas</h2>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* Campanha 1: Black Friday */}
        <CampaignCard
          id="camp-1"
          nome="Black Friday Teleco"
          status="running"
          mensagensEnviadas={1247}
          limite={2000}
          criadoEm="20/11/2024"
        />

        {/* Campanha 2: Catálogo */}
        <CampaignCard
          id="camp-2"
          nome="Novo Catálogo - Outono"
          status="paused"
          mensagensEnviadas={342}
          limite={5000}
          criadoEm="05/11/2024"
        />

        {/* Campanha 3: Aniversário */}
        <CampaignCard
          id="camp-3"
          nome="Aniversário Clients"
          status="finished"
          mensagensEnviadas={500}
          limite={500}
          criadoEm="10/10/2024"
        />
      </div>

      {/* Botão Nova Campanha no final */}
      <a href="/campanhas/criar" className="mt-4 inline-block">
        <svg
          className="w-5 h-5 inline mr-1"
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path d="M9 5l-4 4 1.41 1.41L11 9l4-4-1.41-1.41z" />
          <path d="M15 5l-4 4 1.41 1.41L16 9l4-4-1.41-1.41z" />
        </svg>
        Nova Campanha
      </a>
    </div>
  );
}