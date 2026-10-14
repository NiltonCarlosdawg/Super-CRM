import { useState } from "react";

export function RhythmWarning() {
  import { useState } from "react";

  // Em produção, esses dados viriam do backend API
  let proximoLimite = 158;
  let percentual = 84.2;

  // Simular verificação a cada 5 segundos
  const checkLimit = () => {
    // Dados mock para demo
    const msgsHoje = 842;
    const limite = 1000;
    const restante = limite - msgsHoje;
    proximoLimite = restante;
    percentual = (msgsHoje / limite) * 100;
  };

  checkLimit();

  return (
    <div
      className="border-l-4 border-warning/5 bg-warning/5 rounded-lg p-3 mb-4"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="flex items-start">
        {/* Ícone de aviso */}
        <svg
          className="w-5 h-5 flex-shrink-0 mt-0.5 mr-3 fill-warning"
          viewBox="0 0 20 20"
          aria-hidden="true"
        >
          <path d="M20 15.28l-4.23-4.23a.8.8 0 0 0-1.12-.08l-5.06 5.06a.8.8 0 0 0-.08 1.12l4.91 4.91a.8.8 0 0 0 1.12.08l4.27-4.23a.8.8 0 0 0 .08-1.12L9.64 15l4.68-4.68a.8.8 0 0 0-.08-1.12z" />
          <ellipse cx="5" cy="5" rx="3" ry="2" fill="white" />
          <path d="M12 8v4l3 3" />
        </svg>

        {/* Conteúdo do aviso */}
        <div>
          <div className="font-medium">Atenção: Limite de mensagens</div>
          <div className="text-sm text-warning-foreground mt-1">
            {"Você enviou " + Math.round(percentual) + "% do seu limite diário"}
          </div>
          <div className="mt-2">
            <span className="font-medium">{proximoLimite} mensagens restantes</span>
            {" até o reinício do limite"}
          </div>
        </div>
      </div>
    </div>
  );
}