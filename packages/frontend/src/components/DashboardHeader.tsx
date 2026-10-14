import { useState } from "react";

export function DashboardHeader() {
  const [lightMode, setLightMode] = useState(
    localStorage.getItem("theme") === "dark" ? false : true
  );

  const toggleTheme = () => {
    setLightMode(!lightMode);
    const newTheme = lightMode ? "light" : "dark";
    localStorage.setItem("theme", newTheme);
    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(newTheme);
  };

  return (
    <header className="border-b bg-background/80 backdrop-blur-md sticky top-0 z-50" data-theme={lightMode ? "light" : "dark"}>
      <div className="max-w-7xl mx-auto px-4 flex items-center justify-between h-16">
        <h1 className="font-serif font-medium text-lg">
          <span className="hidden sm:inline">Verano Labs CRM</span>
          <span className="block sm:hidden">Verano Labs</span>
        </h1>

        <div className="flex items-center gap-3">
          <button
            onClick={toggleTheme}
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

          <div className="hidden sm:flex items-center gap-2">
            <span className="text-sm text-foreground">Usuário</span>
            <svg
              className="w-4 h-4"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path d="M9.5 16.59L10.5 15.41l1.42 1.41L12 16l1.41-1.41L9.5 18.41 8.09 17 10.5 15.41 9.5 16 11.91 13.5z" />
            </svg>
          </div>
        </div>
      </div>
    </header>
  );
}