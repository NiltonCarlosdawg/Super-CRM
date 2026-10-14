import { Badge } from "./Badge";

type CampaignCardProps = {
  id: string;
  nome: string;
  status: "running" | "paused" | "finished";
  mensagensEnviadas: number;
  limite: number;
  criadoEm: string;
};

export default function CampaignCard({ id, nome, status, mensagensEnviadas, limite, criadoEm }: CampaignCardProps) {
  const statusBadge = status === "running"
    ? <Badge variant="running" />
    : status === "paused"
      ? <Badge variant="paused" />
      : <Badge variant="finished" />;

  const progresso = (mensagensEnviadas / limite) * 100;

  return (
    <div className="bg-card rounded-lg shadow-sm p-5 hover:bg-muted/50 transition-colors cursor-pointer">
      <div className="flex justify-between items-start mb-3">
        <h3 className="font-serif font-medium text-lg">{nome}</h3>
        {statusBadge}
      </div>

      <div className="mb-3">
        <div className="text-xs text-muted-foreground mb-1">Enviados</div>
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full rounded-full bg-primary transition-all duration-500 ${progresso > 80 ? "bg-red-600" : ""} w-${progresso}%`}
            aria-label="Progresso: ${progresso.toFixed(1)}%"
          />
        </div>
        <div className="text-xs mt-1 flex justify-between">
          <span>{mensagensEnviadas}</span>
          <span>{limite}</span>
        </div>
      </div>

      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <span>{criadoEm}</span>
        <div>
          <a href={`/campanhas/criar?edit=${id}`} className="underline hover:text-primary">Editar</a>
          <a href={`/campanhas/${id}`} className="underline hover:text-primary">Ver detalhes</a>
        </div>
      </div>
    </div>
  );
}