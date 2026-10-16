// Campanhas (Task 13): placeholder HONESTO para a fase seguinte — controlos
// visíveis mas desactivados e marcados, sem dados falsos (o antigo TopCards
// inventava "842 mensagens"; o backend ainda não tem rotas de campanhas).

import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";

export default function CampaignsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-2xl font-light text-fg">Campanhas</h1>
        <p className="mt-1 text-sm text-muted">
          Envios em massa com limites de ritmo — ainda não disponíveis nesta fase.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="solid" disabled aria-disabled="true">
          Nova campanha
        </Button>
        <Badge tone="warning">Por implementar</Badge>
      </div>

      <EmptyState
        title="Campanhas — fase seguinte"
        description="A criação e o envio de campanhas chegam numa fase futura do CRM. Enquanto isso, as conversas individuais já funcionam pela página Conversas."
      />

      <div className="flex flex-col gap-3 border border-border bg-surface p-4 opacity-60">
        <span className="text-sm text-muted">Vista prévia (desactivada)</span>
        <div className="flex flex-col gap-2 text-sm text-muted">
          <label className="flex items-center gap-2">
            <input type="radio" name="preview-state" disabled />
            Estado da campanha
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" disabled />
            Limites de envio diário
          </label>
          <Button variant="outline" disabled aria-disabled="true">
            Iniciar envio
          </Button>
        </div>
      </div>
    </div>
  );
}
