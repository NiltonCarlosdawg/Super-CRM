import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { useSession } from "../lib/auth";
import {
  createPanelSocket,
  defaultIoFactory,
  PanelSocketProvider,
  type PanelSocket,
} from "../lib/socket";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

/**
 * Layout autenticado (Task 5): Sidebar + TopBar + conteúdo. O socket vive
 * AQUI — o shell só monta com sessão completa, por isso a ligação nasce e
 * morre com a sessão visível (o backend recusa handshake sem sessão/MFA ok).
 */
export function AppShell() {
  const { user, logout } = useSession();
  const [socket, setSocket] = useState<PanelSocket | null>(null);

  useEffect(() => {
    const panel = createPanelSocket(defaultIoFactory);
    // Inicialização de recurso externo no mount (ligação real ao Socket.IO):
    // o provider precisa do valor para re-renderizar os useEvent — exceção
    // justificada à regra de pureza, sem cascata de renders.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSocket(panel);
    return () => panel.disconnect();
  }, []);

  return (
    <PanelSocketProvider socket={socket}>
      <div className="flex min-h-screen">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar user={user} onLogout={() => void logout()} />
          <main className="flex-1 p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </PanelSocketProvider>
  );
}
