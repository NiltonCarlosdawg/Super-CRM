// Dashboard (Task 12): métricas DERIVADAS dos endpoints reais — nada de
// números fixos como o antigo TopCards (apagado). deriveMetrics é puro e
// testado; a página lê /v1/whatsapp-accounts + /v1/conversations?limit=50 e
// refaz o GET quando o tempo real muda uma conta (account.status, docs/02 §9).

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useEvent } from "../lib/socket";
import { relativeTime } from "../lib/time";
import type { AccountRow, AccountStatus, ConversationView } from "../lib/types";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";

const STATUS_ORDER: AccountStatus[] = ["connected", "connecting", "disconnected", "suspected_ban"];

/** Rótulos do cartão — estado + contagem no mesmo elemento (a11y legível). */
const CARD_LABELS: Record<AccountStatus, string> = {
  connected: "Contas ligadas",
  connecting: "A ligar",
  disconnected: "Desligadas",
  suspected_ban: "Suspeitas",
};

const CARD_TONES: Record<AccountStatus, BadgeTone> = {
  connected: "success",
  connecting: "info",
  disconnected: "neutral",
  suspected_ban: "danger",
};

export interface Metrics {
  porEstado: Record<AccountStatus, number>;
  totalConversas: number;
  /** Até 5 conversas, mais recente primeiro; lastMessageAt nulo vai no fim. */
  ultimas: ConversationView[];
}

/** Métricas derivadas: contagem por estado + últimas 5 por lastMessageAt desc. */
export function deriveMetrics(
  accounts: AccountRow[],
  conversations: ConversationView[],
): Metrics {
  const porEstado: Record<AccountStatus, number> = {
    connected: 0,
    connecting: 0,
    disconnected: 0,
    suspected_ban: 0,
  };
  for (const account of accounts) porEstado[account.status] += 1;

  const ordenadas = [...conversations].sort((a, b) => {
    if (a.lastMessageAt === null && b.lastMessageAt === null) return 0;
    if (a.lastMessageAt === null) return 1; // nulos no fim
    if (b.lastMessageAt === null) return -1;
    return b.lastMessageAt.localeCompare(a.lastMessageAt); // ISO: comparação lexical = cronológica
  });

  return {
    porEstado,
    totalConversas: conversations.length,
    ultimas: ordenadas.slice(0, 5),
  };
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.detail ?? "Erro ao comunicar com o servidor";
  return "Erro inesperado";
}

export default function DashboardPage() {
  const { error: toastError } = useToast();
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [conversations, setConversations] = useState<ConversationView[] | null>(null);

  const loadAccounts = useCallback(() => {
    return api
      .get<{ accounts: AccountRow[] }>("/v1/whatsapp-accounts")
      .then((result) => {
        setAccounts(result.accounts);
      })
      .catch((error: unknown) => {
        toastError(errorText(error));
      });
  }, [toastError]);

  const loadConversations = useCallback(() => {
    return api
      .get<{ conversations: ConversationView[] }>("/v1/conversations", { limit: "50" })
      .then((result) => {
        setConversations(result.conversations);
      })
      .catch((error: unknown) => {
        toastError(errorText(error));
      });
  }, [toastError]);

  useEffect(() => {
    void loadAccounts();
    void loadConversations();
  }, [loadAccounts, loadConversations]);

  // O estado das contas muda sem novo GET (evento em tempo real).
  useEvent("account.status", () => {
    void loadAccounts();
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-2xl font-light text-fg">Dashboard</h1>
        <p className="mt-1 text-sm text-muted">
          Visão geral das contas WhatsApp e das conversas recentes.
        </p>
      </div>

      {accounts === null || conversations === null ? (
        <Spinner label="A carregar o painel" />
      ) : (
        <DashboardReady accounts={accounts} conversations={conversations} />
      )}
    </div>
  );
}

function DashboardReady({
  accounts,
  conversations,
}: {
  accounts: AccountRow[];
  conversations: ConversationView[];
}) {
  const metrics = deriveMetrics(accounts, conversations);
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {STATUS_ORDER.map((status) => (
          <div key={status} className="flex flex-col gap-2 border border-border bg-surface p-4">
            <span className="text-sm text-muted">{CARD_LABELS[status]}</span>
            <span className="font-display text-3xl font-light text-fg">
              <span className="sr-only">{CARD_LABELS[status]}: </span>
              {metrics.porEstado[status]}
            </span>
            <Badge tone={CARD_TONES[status]}>
              {status === "connected"
                ? "Prontas a enviar"
                : status === "connecting"
                  ? "A aguardar emparelhamento"
                  : status === "disconnected"
                    ? "Fora do painel"
                    : "Decisão humana"}
            </Badge>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2 border border-border bg-surface p-4">
        <span className="text-sm text-muted">Total de conversas</span>
        <span className="font-display text-3xl font-light text-fg">
          {metrics.totalConversas}
        </span>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-lg font-light text-fg">Últimas conversas</h2>
        {conversations.length === 0 ? (
          <EmptyState
            title="Sem conversas ainda"
            description="As mensagens recebidas aparecem aqui."
          />
        ) : (
          <div className="flex flex-col border border-border bg-surface">
            {metrics.ultimas.map((conversation) => (
              <Link
                key={conversation.id}
                to={`/conversations/${conversation.id}`}
                className="flex items-center justify-between gap-4 border-b border-border/60 px-4 py-3 text-sm transition-colors last:border-b-0 hover:bg-accent-soft"
              >
                <span className="text-fg">{conversation.contactPhone}</span>
                <span className="text-muted">
                  {conversation.lastMessageAt === null
                    ? "Sem mensagens"
                    : relativeTime(conversation.lastMessageAt)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
