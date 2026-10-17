// Guardas de rota (Task 5): a sessão é a única fonte de verdade. Quem decide
// permissões a sério é o backend — aqui só se esconde o que não se pode usar.

import { useEffect, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useSession } from "../lib/auth";
import { useOptionalToast } from "./ui/Toast";
import { Spinner } from "./ui/Spinner";

function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner label="A verificar sessão" />
    </div>
  );
}

/** Toast honesto quando uma rota admin é alcançada por URL directo (Task 11).
 * Monta ANTES do Navigate — o efeito corre na mesma fase, antes do redirect. */
function NoticeOnMount({ message }: { message: string }) {
  const toast = useOptionalToast();
  useEffect(() => {
    toast?.error(message);
  }, [toast, message]);
  return null;
}

/** Exige sessão completa — estados MFA pendentes completam o TOTP no /login. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useSession();
  if (status === "loading") return <Loading />;
  if (status !== "authed") return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** Exige papel admin — a rota vive dentro do RequireAuth (authed garantido).
 * `notice` (Task 11): toast honesto antes do redirect (ex.: /accounts por URL
 * directo a não-admin). Sem provider de toast, o redirect acontece na mesma. */
export function RequireAdmin({
  children,
  notice,
}: {
  children: ReactNode;
  notice?: string;
}) {
  const { status, user } = useSession();
  if (status === "loading") return <Loading />;
  if (user?.role !== "admin") {
    return (
      <>
        {notice !== undefined && <NoticeOnMount message={notice} />}
        <Navigate to="/" replace />
      </>
    );
  }
  return <>{children}</>;
}

/** Exige âmbito de plataforma (platform_admin) — a rota vive dentro do RequireAuth. */
export function RequirePlatform({ children }: { children: ReactNode }) {
  const { status, user } = useSession();
  if (status === "loading") return <Loading />;
  if (user?.scope !== "platform") return <Navigate to="/" replace />;
  return <>{children}</>;
}
