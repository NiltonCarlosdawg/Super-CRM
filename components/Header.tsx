import { useState } from "react";

export function Header() {
  const [lightMode, setLightMode] = useState(true);

  return (
    <header className="border-b bg-background/80 backdrop-blur-md sticky top-0 z-50" data-theme={lightMode ? "light" : "dark"}>
      <div className="max-w-7xl mx-auto px-4 flex items-center justify-between h-16">
        <h1 className="font-serif font-medium text-lg">
          <span className="hidden sm:inline">Verano Labs CRM</span>
          <span className="block sm:hidden">Verano Labs</span>
        </h1>

        <div className="hidden md:flex items-center gap-6">
          {/* Links do header para pages internas */}
        </div>

        <div className="flex items-center gap-3">
          {/* Toggle light/dark mode */}
          <button
            onClick={() => setLightMode(!lightMode)}
            className="p-2 rounded-md hover:bg-muted focus-visible:outline focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Alternar modo light/dark"
          >
            {lightMode ? (
              <svg
                className="w-5 h-5"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path d="M2 2a2 2 0 0 1 2-2h3.89l.482.482A2 2 0 0 1 9.88 5h5.62l-.52 1.06A2 2 0 0 1 15 6.88V14a2 2 0 0 1-2 2h-3.89l-.482.482A2 2 0 0 1 10.12 15H7a2 2 0 0 1-2-2H2z" />
                <path d="M10 5a1 1 0 0 1 1 1v6a1 1 0 0 1-2 0V6a1 1 0 0 1 1-1zm0 13a1 1 0 0 1 1 1v6a1 1 0 0 1-2 0v-6a1 1 0 0 1 1-1zm4-6a3 3 0 0 0-3-3H5a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3z" />
              </svg>
            ) : (
              <svg
                className="w-5 h-5"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path d="M2 2a2 2 0 0 1 2-2h2.18l.388.392A2 2 0 0 1 6.64 5h12.73l-.388.392A2 2 0 0 1 17.82 15H6.36l.388-.392A2 2 0 0 1 2 14V2z" />
                <path d="M8.5 10.5a1 1 0 0 1 1.414-1.414L11.414 9H7a1 1 0 0 0 0 2h4.414l2.914 2.914a1 1 0 0 1-1.414 1.414L10 11.414H5a1 1 0 0 0 0 2h1.414L8.5 12.914z" />
              </svg>
            )}
          </button>

          {/* Botões Login/Cadastro (mobile e small screens) */}
          <div className="flex items-center gap-2 sm:hidden">
            <a
              href="/auth/login"
              className="btn btn-outline text-sm"
              aria-label="Login"
            >
              Login
            </a>
            <a
              href="/auth/register"
              className="btn btn-primary text-sm"
              aria-label="Cadastro"
            >
              Cadastro
            </a>
          </div>
        </div>
      </div>
    </header>
  );
}