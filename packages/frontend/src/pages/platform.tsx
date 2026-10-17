// Plataforma (Onda 1, Task 10; spec multitenant §6): tabela de tenants com
// contagens e ciclo de vida (suspend/activate com modal de confirmação) e
// drill READ-ONLY de suporte (users, contas, conversas + thread). Só âmbito
// de plataforma chega aqui (RequirePlatform na rota, main.tsx) — o backend
// também recusa (requirePlatform), aqui só se esconde o inutilizável.
//
// Contratos (routes/platform.ts do backend): GET /v1/platform/tenants devolve
// um ARRAY directo (ruling R23 — NÃO {tenants:[...]}); suspend/activate são
// POST → 204 sem corpo; o drill envelopa como as rotas de tenant
// ({users}, {accounts}, {conversations,nextCursor}, {conversation,lastMessage}).

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import {
  accountPurposeLabel,
  accountStatusLabel,
  aiModeLabel,
  roleLabel,
  tenantStatusLabel,
  userStatusLabel,
} from "../lib/labels";
import { relativeTime } from "../lib/time";
import type {
  AccountRow,
  ConversationDetail,
  ConversationView,
  ConversationsList,
  TenantListItem,
  UserSummary,
} from "../lib/types";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Modal } from "../components/ui/Modal";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.detail ?? "Erro ao comunicar com o servidor";
  return "Erro inesperado";
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-AO", { day: "2-digit", month: "short", year: "numeric" }).format(
    date,
  );
}

/* ------------------------------- Drill ---------------------------------- */

function DrillUsers({ tenantId }: { tenantId: string }) {
  const { error: toastError } = useToast();
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    api
      .get<{ users: UserSummary[] }>(`/v1/platform/tenants/${tenantId}/users`)
      .then((result) => {
        setFailed(false);
        setUsers(result.users);
      })
      .catch((error: unknown) => {
        setFailed(true);
        toastError(errorText(error));
      });
  }, [tenantId, toastError]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section aria-label="Utilizadores do tenant" className="flex flex-col gap-3">
      <h2 className="font-display text-lg text-fg">Utilizadores</h2>
      {users === null ? (
        failed ? (
          <EmptyState
            title="Não foi possível carregar os utilizadores"
            description="Verifica a ligação e tenta de novo."
          >
            <Button variant="outline" onClick={load}>
              Tentar de novo
            </Button>
          </EmptyState>
        ) : (
          <Spinner label="A carregar utilizadores" />
        )
      ) : users.length === 0 ? (
        <EmptyState title="Sem utilizadores" />
      ) : (
        <div className="border border-border bg-surface">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase text-muted">
                <th scope="col" className="px-4 py-3 font-normal">
                  Nome
                </th>
                <th scope="col" className="px-4 py-3 font-normal">
                  Email
                </th>
                <th scope="col" className="px-4 py-3 font-normal">
                  Papel
                </th>
                <th scope="col" className="px-4 py-3 font-normal">
                  Estado
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-b border-border/60 last:border-b-0">
                  <td className="px-4 py-3 text-fg">{user.name}</td>
                  <td className="px-4 py-3 text-muted">{user.email}</td>
                  <td className="px-4 py-3">
                    <Badge tone="info">{roleLabel(user.role)}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={user.active ? "success" : "neutral"}>
                      {userStatusLabel(user.active)}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function DrillAccounts({ tenantId }: { tenantId: string }) {
  const { error: toastError } = useToast();
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    api
      .get<{ accounts: AccountRow[] }>(`/v1/platform/tenants/${tenantId}/accounts`)
      .then((result) => {
        setFailed(false);
        setAccounts(result.accounts);
      })
      .catch((error: unknown) => {
        setFailed(true);
        toastError(errorText(error));
      });
  }, [tenantId, toastError]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section aria-label="Contas WhatsApp do tenant" className="flex flex-col gap-3">
      <h2 className="font-display text-lg text-fg">Contas WhatsApp</h2>
      {accounts === null ? (
        failed ? (
          <EmptyState
            title="Não foi possível carregar as contas"
            description="Verifica a ligação e tenta de novo."
          >
            <Button variant="outline" onClick={load}>
              Tentar de novo
            </Button>
          </EmptyState>
        ) : (
          <Spinner label="A carregar contas" />
        )
      ) : accounts.length === 0 ? (
        <EmptyState title="Sem contas" />
      ) : (
        <div className="border border-border bg-surface">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase text-muted">
                <th scope="col" className="px-4 py-3 font-normal">
                  Etiqueta
                </th>
                <th scope="col" className="px-4 py-3 font-normal">
                  Telefone
                </th>
                <th scope="col" className="px-4 py-3 font-normal">
                  Estado
                </th>
                <th scope="col" className="px-4 py-3 font-normal">
                  Função
                </th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id} className="border-b border-border/60 last:border-b-0">
                  <td className="px-4 py-3 text-fg">{account.label}</td>
                  <td className="px-4 py-3 text-muted">{account.phoneE164 ?? "—"}</td>
                  <td className="px-4 py-3">
                    <Badge tone={account.status === "connected" ? "success" : "neutral"}>
                      {accountStatusLabel(account.status)}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-muted">{accountPurposeLabel(account.purpose)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Thread read-only: o contrato do drill só devolve a conversa + última mensagem. */
function DrillThread({
  tenantId,
  conversationId,
  onBack,
}: {
  tenantId: string;
  conversationId: string;
  onBack(): void;
}) {
  const { error: toastError } = useToast();
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api
      .get<ConversationDetail>(`/v1/platform/tenants/${tenantId}/conversations/${conversationId}`)
      .then((result) => setDetail(result))
      .catch((error: unknown) => {
        setFailed(true);
        toastError(errorText(error));
      });
  }, [tenantId, conversationId, toastError]);

  return (
    <section aria-label="Conversa" className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" onClick={onBack}>
          ← Voltar às conversas
        </Button>
        <span className="text-xs text-muted">Leitura — sem acções (suporte)</span>
      </div>

      {failed ? (
        <EmptyState
          title="Não foi possível abrir a conversa"
          description="Volta à lista e tenta de novo."
        />
      ) : detail === null ? (
        <Spinner label="A abrir conversa" />
      ) : (
        <>
          <div className="flex items-center gap-3">
            <h2 className="font-display text-lg text-fg">{detail.conversation.contactPhone}</h2>
            <Badge tone="info">{aiModeLabel(detail.conversation.aiMode)}</Badge>
          </div>
          {detail.lastMessage === null ? (
            <EmptyState title="Sem mensagens" />
          ) : (
            <div className="flex justify-start">
              <div className="max-w-[75%] border border-border bg-surface px-3 py-2 text-sm">
                <p className="whitespace-pre-wrap break-words text-fg">{detail.lastMessage.body}</p>
                <div className="mt-1 flex justify-between gap-3 text-xs text-muted">
                  <span>{relativeTime(detail.lastMessage.createdAt)}</span>
                  <span>{detail.lastMessage.direction === "inbound" ? "Recebida" : "Enviada"}</span>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Drill({
  tenant,
  onBack,
}: {
  tenant: TenantListItem;
  onBack(): void;
}) {
  const { error: toastError } = useToast();
  const [conversations, setConversations] = useState<ConversationView[] | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    api
      .get<ConversationsList>(`/v1/platform/tenants/${tenant.id}/conversations`)
      .then((result) => {
        setFailed(false);
        setConversations(result.conversations);
      })
      .catch((error: unknown) => {
        setFailed(true);
        toastError(errorText(error));
      });
  }, [tenant.id, toastError]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-light text-fg">{tenant.name}</h1>
          <p className="mt-1 text-sm text-muted">Inspeção read-only de suporte.</p>
        </div>
        <Button variant="outline" onClick={onBack}>
          ← Voltar à lista
        </Button>
      </div>

      {conversationId !== null ? (
        <DrillThread
          tenantId={tenant.id}
          conversationId={conversationId}
          onBack={() => setConversationId(null)}
        />
      ) : (
        <>
          <DrillUsers tenantId={tenant.id} />
          <DrillAccounts tenantId={tenant.id} />
          <section aria-label="Conversas do tenant" className="flex flex-col gap-3">
            <h2 className="font-display text-lg text-fg">Conversas</h2>
            {conversations === null ? (
              failed ? (
                <EmptyState
                  title="Não foi possível carregar as conversas"
                  description="Verifica a ligação e tenta de novo."
                >
                  <Button variant="outline" onClick={load}>
                    Tentar de novo
                  </Button>
                </EmptyState>
              ) : (
                <Spinner label="A carregar conversas" />
              )
            ) : conversations.length === 0 ? (
              <EmptyState title="Sem conversas" />
            ) : (
              <div className="flex flex-col border border-border bg-surface">
                {conversations.map((conversation) => (
                  <div
                    key={conversation.id}
                    className="flex items-center justify-between gap-3 border-b border-border/60 px-4 last:border-b-0"
                  >
                    <button
                      type="button"
                      onClick={() => setConversationId(conversation.id)}
                      className="py-3 text-left text-sm text-fg transition-colors hover:text-accent"
                    >
                      {conversation.contactPhone}
                    </button>
                    <span className="text-xs text-muted">
                      {conversation.lastMessageAt === null
                        ? "sem mensagens"
                        : relativeTime(conversation.lastMessageAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/* ------------------------------- Página ---------------------------------- */

/** Acção de ciclo de vida pendente de confirmação no modal. */
interface PendingAction {
  tenant: TenantListItem;
  action: "suspend" | "activate";
}

export default function PlatformPage() {
  const { show, error: toastError } = useToast();
  const [tenants, setTenants] = useState<TenantListItem[] | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [drill, setDrill] = useState<TenantListItem | null>(null);
  const [failed, setFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(() => {
    return api
      .get<TenantListItem[]>("/v1/platform/tenants")
      .then((result) => {
        setFailed(false);
        setTenants(result);
      })
      .catch((error: unknown) => {
        setFailed(true);
        toastError(errorText(error));
      });
  }, [toastError]);

  useEffect(() => {
    void load();
  }, [load]);

  const confirmAction = () => {
    if (pending === null || submitting) return; // 2.º clique durante o POST: ignora
    const { tenant, action } = pending;
    setSubmitting(true);
    api
      .post(`/v1/platform/tenants/${tenant.id}/${action}`)
      .then(() => {
        setTenants((prev) =>
          prev === null
            ? prev
            : prev.map((item) =>
                item.id === tenant.id
                  ? { ...item, status: action === "suspend" ? "suspended" : "active" }
                  : item,
              ),
        );
        show(action === "suspend" ? "Empresa suspensa" : "Empresa activada");
      })
      .catch((error: unknown) => {
        toastError(errorText(error));
        void load(); // ex.: 404 — repor o estado real do servidor
      })
      .finally(() => {
        setSubmitting(false);
        setPending(null);
      });
  };

  if (drill !== null) {
    return <Drill tenant={drill} onBack={() => setDrill(null)} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-2xl font-light text-fg">Plataforma</h1>
        <p className="mt-1 text-sm text-muted">
          Empresas registadas: estado, contagens e ciclo de vida.
        </p>
      </div>

      {tenants === null ? (
        failed ? (
          <EmptyState
            title="Não foi possível carregar as empresas"
            description="Verifica a ligação e tenta de novo."
          >
            <Button variant="outline" onClick={() => void load()}>
              Tentar de novo
            </Button>
          </EmptyState>
        ) : (
          <Spinner label="A carregar empresas" />
        )
      ) : tenants.length === 0 ? (
        <EmptyState
          title="Sem empresas"
          description="Assim que uma empresa se registar, aparece aqui."
        />
      ) : (
        <div className="border border-border bg-surface">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase text-muted">
                <th scope="col" className="px-4 py-3 font-normal">
                  Nome
                </th>
                <th scope="col" className="px-4 py-3 font-normal">
                  Estado
                </th>
                <th scope="col" className="px-4 py-3 font-normal">
                  Utilizadores
                </th>
                <th scope="col" className="px-4 py-3 font-normal">
                  Contas
                </th>
                <th scope="col" className="px-4 py-3 font-normal">
                  Criado em
                </th>
                <th scope="col" className="px-4 py-3 font-normal">
                  Acções
                </th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((tenant) => (
                <tr key={tenant.id} className="border-b border-border/60 last:border-b-0">
                  <td className="px-4 py-3 text-fg">{tenant.name}</td>
                  <td className="px-4 py-3">
                    <Badge tone={tenant.status === "active" ? "success" : "warning"}>
                      {tenantStatusLabel(tenant.status)}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-muted">{tenant.usersCount}</td>
                  <td className="px-4 py-3 text-muted">{tenant.accountsCount}</td>
                  <td className="px-4 py-3 text-muted">{formatDate(tenant.createdAt)}</td>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2">
                      {tenant.status === "active" ? (
                        <Button
                          variant="outline"
                          className="px-2 py-1 text-xs"
                          aria-label={`Suspender ${tenant.name}`}
                          onClick={() => setPending({ tenant, action: "suspend" })}
                        >
                          Suspender
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          className="px-2 py-1 text-xs"
                          aria-label={`Activar ${tenant.name}`}
                          onClick={() => setPending({ tenant, action: "activate" })}
                        >
                          Activar
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        className="px-2 py-1 text-xs"
                        aria-label={`Ver detalhes de ${tenant.name}`}
                        onClick={() => setDrill(tenant)}
                      >
                        Detalhes
                      </Button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={pending !== null}
        title={
          pending === null
            ? ""
            : pending.action === "suspend"
              ? `Suspender ${pending.tenant.name}`
              : `Activar ${pending.tenant.name}`
        }
        onClose={() => setPending(null)}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            {pending?.action === "suspend"
              ? "A empresa deixa de entrar no painel e de enviar mensagens até ser reactivada. Continua?"
              : "A empresa volta a entrar no painel e a enviar mensagens. Continuar?"}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPending(null)}>
              Cancelar
            </Button>
            <Button variant="solid" disabled={submitting} onClick={confirmAction}>
              {submitting ? (
                <Spinner label="A concluir" />
              ) : pending?.action === "suspend" ? (
                "Suspender"
              ) : (
                "Activar"
              )}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
