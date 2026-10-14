import { useState } from "react";

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div
      className="w-64 bg-card min-h-screen flex flex-col border-l transition-all duration-200 ease-in-out shadow-sm"
      style={{ width: collapsed ? "64px" : "200px" }}
    >
      {/* Quando collapsed, esconder texto, mostrar apenas ícones */}
      <flex className="flex flex-col h-full p-4 pt-6">
        {/* Toggle botão para expandir/collapsar */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="mb-6 flex items-center justify-between"
          aria-label="Expandir/Colapsar menu"
        >
          {collapsed
            ? (
              <span className="sr-only">Expandir menu</span>
            ) : (
              <span className="sr-only">Colapsar menu</span>
            )}
          </button>

          {/* Links do menu - quando collapsed, só mostra ícone */}
          <nav className="flex flex-col gap-2">
            {/* Campanhas */}
            <a
              href="/campanhas"
              className="flex items-center px-3 py-2 rounded-md text-sm font-medium transition-colors hover:bg-muted/50"
              aria-label="Campanhas"
            >
              {collapsed
                ? () // ícone só
                : "Campanhas"
              }
              <svg
                className="w-5 h-5 mr-2"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path d="M3 3a1 1 0 0 1 1 1v16a1 1 0 0 1-2 0V4a1 1 0 0 1 1-1zm12 2h2.286l.53 5.195a1 1 0 0 0 1.06 0l.53-5.195H15v6h-2l-1.105-4.33a1 1 0 0 0-.394-1.15L14 5.125z" />
              </svg>
            </a>

            {/* Contas */}
            <a
              href="/contas"
              className="flex items-center px-3 py-2 rounded-md text-sm font-medium transition-colors hover:bg-muted/50"
              aria-label="Contas"
            >
              {collapsed ? () : "Contas"}
              <svg
                className="w-5 h-5 mr-2"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path d="M3 3a1 1 0 0 1 1 1v16a1 1 0 0 1-2 0V4a1 1 0 0 1 1-1zm12 2h2.286l.53 5.195a1 1 0 0 0 1.06 0l.53-5.195H15v6h-2l-1.105-4.33a1 1 0 0 0-.394-1.15L14 5.125z" />
              </svg>
            </a>

            {/* Conversas */}
            <a
              href="/conversas"
              className="flex items-center px-3 py-2 rounded-md text-sm font-medium transition-colors hover:bg-muted/50"
              aria-label="Conversas"
            >
              {collapsed ? () : "Conversas"}
              <svg
                className="w-5 h-5 mr-2"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path d="M2 3a1 1 0 0 1 1 1h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3zm14 4.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" />
                <path d="M12 8a4 4 0 0 0-4 4v2a4 4 0 0 0 4 4v2a4 4 0 0 0 4-4v-2a4 4 0 0 0-4-4v-2zm0 0v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2hzm0-2a2 2 0 1 1 0-4 2 2 0 0 1 0 4z" />
              </svg>
            </a>
          </nav>
        </flex>
      </flex>
    </div>
  );
}