import { NavLink } from "react-router-dom";
import { useSession } from "../lib/auth";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/accounts", label: "Contas" },
  { to: "/conversations", label: "Conversas" },
  { to: "/campaigns", label: "Campanhas" },
];

// Onda 1 (Task 10): plataforma não pertence a nenhum tenant — vê SÓ a sua
// página (spec multitenant §6); os papéis de tenant mantêm o menu actual,
// sem qualquer link de plataforma.
const PLATFORM_NAV_ITEMS = [{ to: "/platform", label: "Plataforma", end: false }];

const linkClass = ({ isActive }: { isActive: boolean }): string =>
  `block px-3 py-2 text-sm transition-colors ${
    isActive ? "bg-accent-soft text-fg" : "text-muted hover:bg-accent-soft hover:text-fg"
  }`;

export function Sidebar() {
  const { user } = useSession();
  const isPlatform = user?.scope === "platform";
  const items = isPlatform ? PLATFORM_NAV_ITEMS : NAV_ITEMS;
  return (
    <aside
      aria-label="Menu lateral"
      className="flex w-60 shrink-0 flex-col border-r border-border bg-surface"
    >
      <div className="border-b border-border px-5 py-4">
        <span className="font-display text-lg font-light text-fg">MilVendas CRM</span>
      </div>
      <nav className="flex flex-1 flex-col gap-1 p-3">
        {items.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={linkClass}>
            {item.label}
          </NavLink>
        ))}
        {user?.role === "admin" && (
          <NavLink to="/users" className={linkClass}>
            Utilizadores
          </NavLink>
        )}
      </nav>
    </aside>
  );
}
