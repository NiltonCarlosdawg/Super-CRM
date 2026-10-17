import { NavLink } from "react-router-dom";
import { useSession } from "../lib/auth";

interface NavItem {
  to: string;
  label: string;
  end?: boolean;
  /** Onda 1, Task 11: /accounts é admin-only no cliente (RequireAdmin). */
  adminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/accounts", label: "Contas", adminOnly: true },
  { to: "/conversations", label: "Conversas" },
  { to: "/campaigns", label: "Campanhas" },
  { to: "/settings", label: "Definições" },
];

// Onda 1 (Task 10): plataforma não pertence a nenhum tenant — vê SÓ a sua
// página (spec multitenant §6); os papéis de tenant mantêm o menu actual,
// sem qualquer link de plataforma.
const PLATFORM_NAV_ITEMS: NavItem[] = [{ to: "/platform", label: "Plataforma", end: false }];

const linkClass = ({ isActive }: { isActive: boolean }): string =>
  `block px-3 py-2 text-sm transition-colors ${
    isActive ? "bg-accent-soft text-fg" : "text-muted hover:bg-accent-soft hover:text-fg"
  }`;

export function Sidebar() {
  const { user } = useSession();
  const isPlatform = user?.scope === "platform";
  const isAdmin = user?.role === "admin";
  const items = (isPlatform ? PLATFORM_NAV_ITEMS : NAV_ITEMS).filter(
    (item) => item.adminOnly !== true || isAdmin,
  );
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
        {isAdmin && (
          <NavLink to="/users" className={linkClass}>
            Utilizadores
          </NavLink>
        )}
      </nav>
    </aside>
  );
}
