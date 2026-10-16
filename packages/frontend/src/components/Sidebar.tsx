import { NavLink } from "react-router-dom";
import { useSession } from "../lib/auth";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/accounts", label: "Contas" },
  { to: "/conversations", label: "Conversas" },
  { to: "/campaigns", label: "Campanhas" },
];

const linkClass = ({ isActive }: { isActive: boolean }): string =>
  `block px-3 py-2 text-sm transition-colors ${
    isActive ? "bg-accent-soft text-fg" : "text-muted hover:bg-accent-soft hover:text-fg"
  }`;

export function Sidebar() {
  const { user } = useSession();
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface">
      <div className="border-b border-border px-5 py-4">
        <span className="font-display text-lg font-light text-fg">MilVendas CRM</span>
      </div>
      <nav className="flex flex-1 flex-col gap-1 p-3">
        {NAV_ITEMS.map((item) => (
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
