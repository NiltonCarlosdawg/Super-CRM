// Guardas de rota (Task 5): a sessão é a única fonte de verdade. Quem decide
// permissões a sério é o backend — aqui só se esconde o que não se pode usar.

import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useSession } from "../lib/auth";
import { Spinner } from "./ui/Spinner";

function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner label="A verificar sessão" />
    </div>
  );
}

/** Exige sessão completa — estados MFA pendentes completam o TOTP no /login. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useSession();
  if (status === "loading") return <Loading />;
  if (status !== "authed") return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** Exige papel admin — a rota vive dentro do RequireAuth (authed garantido). */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { status, user } = useSession();
  if (status === "loading") return <Loading />;
  if (user?.role !== "admin") return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** Exige âmbito de plataforma (platform_admin) — a rota vive dentro do RequireAuth. */
export function RequirePlatform({ children }: { children: ReactNode }) {
  const { status, user } = useSession();
  if (status === "loading") return <Loading />;
  if (user?.scope !== "platform") return <Navigate to="/" replace />;
  return <>{children}</>;
}
