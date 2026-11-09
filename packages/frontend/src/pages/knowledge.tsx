// Conhecimento (Fases 2–4): um só sítio para treinar a IA e governar o que ela
// sabe. Cinco separadores que espelham as rotas reais do backend — Treino,
// Publicado, Lacunas, Configuração e Teste. editor|admin (RequireRole na rota).

import { useState } from "react";
import { TrainTab } from "./knowledge/train";
import { PublishedTab } from "./knowledge/published";
import { GapsTab } from "./knowledge/gaps";
import { ConfigTab } from "./knowledge/config";
import { TestTab } from "./knowledge/test-chat";

const TABS = [
  { id: "train", label: "Treino" },
  { id: "published", label: "Publicado" },
  { id: "gaps", label: "Lacunas" },
  { id: "config", label: "Configuração" },
  { id: "test", label: "Teste" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function KnowledgePage() {
  const [tab, setTab] = useState<TabId>("train");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-2xl font-light text-fg">Conhecimento</h1>
        <p className="mt-1 text-sm text-muted">
          Treina a IA, revê o que está publicado e testa as respostas antes de as
          deixar chegar aos clientes.
        </p>
      </div>

      <div role="tablist" className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((item) => (
          <button
            key={item.id}
            role="tab"
            type="button"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={`px-4 py-2 text-sm transition-colors ${
              tab === item.id
                ? "border-b-2 border-accent text-fg"
                : "text-muted hover:text-fg"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "train" && <TrainTab />}
      {tab === "published" && <PublishedTab />}
      {tab === "gaps" && <GapsTab />}
      {tab === "config" && <ConfigTab />}
      {tab === "test" && <TestTab />}
    </div>
  );
}
