import { useState } from "react";

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);

  const menuItems = [
    { label: "Campanhas", href: "/campanhas", icon: "📊" },
    { label: "Contas", href: "/contas", icon: "📦" },
    { label: "Conversas", href: "/conversas", icon: "💬" },
  ];

  return (
    <div
      className="w-64 bg-card min-h-screen flex flex-col border-l"
      style={{ width: collapsed ? "64px" : "200px" }}
    >
      <div className="p-4 pt-6">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="mb-4 flex items-center justify-between"
          aria-label="Expandir/Colapsar menu"
        >
          {collapsed
            ? <span className="sr-only">Expandir menu</span>
            : <span className="sr-only">Colapsar menu</span>
          }
        </button>

        <nav className="flex flex-col gap-2">
          {menuItems.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="flex items-center px-3 py-2 rounded-md text-sm font-medium transition-colors hover:bg-muted/50"
              aria-label={item.label}
            >
              {collapsed ? item.icon : item.label}
              <svg
                className="w-5 h-5 mr-2"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path d="M3 3a1 1 0 0 1 1 1v16a1 1 0 0 1-2 0V4a1 1 0 0 1 1-1zm12 2h2.286l.53 5.195a1 1 0 0 0 1.06 0l.53-5.195H15v6h-2l-1.105-4.33a1 1 0 0 0-.394-1.15L14 5.125z" />
              </svg>
            </a>
          ))}
        </nav>
      </div>
    </div>
  );
}