import { useState } from "react";

export function TopCards() {
  const [stats, setStats] = useState({
    contasAtivas: 3,
    campanhasRodando: 1,
    mensagensHoje: 842,
    limiteDiario: 1000,
    conversao: 12.5,
  });

  const [warning, setWarning] = useState(false);

  const checkLimit = () => {
    const { mensagensHoje, limiteDiario } = stats;
    if (mensagensHoje >= limiteDiario * 0.8 && mensagensHoje < limiteDiario) {
      setWarning(true);
    } else {
      setWarning(false);
    }
  };

  checkLimit();

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
      <div className="bg-card p-4 rounded-lg shadow-sm border-l-4 border-primary">
        <h3 className="text-sm font-muted-foreground mb-1">Contas Ativas</h3>
        <h2 className="text-2xl font-serif font-medium">{stats.contasAtivas}</h2>
      </div>

      <div className="bg-card p-4 rounded-lg shadow-sm border-l-4 border-accent">
        <h3 className="text-sm font-muted-foreground mb-1">Campanhas Rodando</h3>
        <h2 className="text-2xl font-serif font-medium">{stats.campanhasRodando}</h2>
      </div>

      <div
        className={`bg-card p-4 rounded-lg shadow-sm border-l-4 border-${warning ? "red" : "primary"} ${warning ? "ring-2 ring-red-500/20" : ""}`}
      >
        <h3 className="text-sm font-muted-foreground mb-1">Mensagens Hoje</h3>
        <h2 className="text-2xl font-serif font-medium">{stats.mensagensHoje}</h2>
        {warning && (
          <span className="mt-2 inline-block px-2 py-0.5 text-sm rounded bg-red-100 text-red-800">
            ⚠️ Próximo do limite (842 de 1000)
          </span>
        )}
      </div>

      <div className="bg-card p-4 rounded-lg shadow-sm border-l-4 border-secondary">
        <h3 className="text-sm font-muted-foreground mb-1">Taxa de Conversão</h3>
        <h2 className="text-2xl font-serif font-medium">{stats.conversao}%</h2>
      </div>
    </div>
  );
}