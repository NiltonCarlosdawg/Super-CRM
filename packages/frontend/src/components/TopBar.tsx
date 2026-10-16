import { roleLabel } from "../lib/labels";
import type { SessionUser } from "../lib/types";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";

export function TopBar({ user, onLogout }: { user: SessionUser | null; onLogout: () => void }) {
  return (
    <header className="flex items-center justify-end border-b border-border px-6 py-3">
      {user !== null && (
        <div className="flex items-center gap-3">
          <span className="text-sm text-fg">{user.name}</span>
          <Badge tone="info">{roleLabel(user.role)}</Badge>
          <Button variant="ghost" onClick={onLogout}>
            Sair
          </Button>
        </div>
      )}
    </header>
  );
}
