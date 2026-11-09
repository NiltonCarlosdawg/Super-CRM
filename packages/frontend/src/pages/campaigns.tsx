// Campanhas reais (Fase 4): lista paginada, criação (só contas purpose=campaigns),
// detalhe com contagens e as três transições humanas — iniciar/agendar, pausar,
// retomar. O backend exige admin, CSRF e Idempotency-Key na criação/início.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import {
  campaignPauseReasonLabel,
  campaignStatusLabel,
  campaignTone,
  canPause,
  canResume,
  canStart,
} from "../lib/campaigns";
import { accountPurposeLabel, accountStatusLabel } from "../lib/labels";
import { relativeTime } from "../lib/time";
import type {
  AccountRow,
  Campaign,
  CampaignCounts,
  CampaignDetail,
  CampaignList,
} from "../lib/types";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Field } from "../components/ui/Field";
import { Modal } from "../components/ui/Modal";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";

const PAGE_SIZE = 20;

const COUNT_LABELS: Record<keyof CampaignCounts, string> = {
  pending: "Pendentes",
  sent: "Enviadas",
  failed: "Falhadas",
  replied: "Respondidas",
  optedOut: "Opt-out",
};

const COUNT_TONES: Record<keyof CampaignCounts, BadgeTone> = {
  pending: "neutral",
  sent: "success",
  failed: "danger",
  replied: "info",
  optedOut: "warning",
};

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.detail ?? "Erro ao comunicar com o servidor";
  return "Erro inesperado";
}

/** Contas que o backend aceita numa campanha (purpose campaigns). */
export function campaignAccounts(accounts: AccountRow[]): AccountRow[] {
  return accounts.filter((account) => account.purpose === "campaigns");
}

export default function CampaignsPage() {
  const { show, error: toastError } = useToast();
  const [items, setItems] = useState<Campaign[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [creating, setCreating] = useState(false);

  const [name, setName] = useState("");
  const [messageTemplate, setMessageTemplate] = useState("");
  const [dailyLimit, setDailyLimit] = useState("");
  const [accountIds, setAccountIds] = useState<string[]>([]);

  const [scheduledAt, setScheduledAt] = useState("");

  const load = useCallback(
    (cursor?: string) => {
      return api
        .get<CampaignList>("/v1/campaigns", {
          limit: String(PAGE_SIZE),
          ...(cursor === undefined ? {} : { cursor }),
        })
        .then((page) => {
          setItems((prev) => (cursor === undefined ? page.items : [...(prev ?? []), ...page.items]));
          setNextCursor(page.nextCursor);
        })
        .catch((error: unknown) => toastError(errorText(error)));
    },
    [toastError],
  );

  const loadDetail = useCallback(
    (id: string) => {
      return api
        .get<CampaignDetail>(`/v1/campaigns/${id}`)
        .then(setDetail)
        .catch((error: unknown) => toastError(errorText(error)));
    },
    [toastError],
  );

  useEffect(() => {
    void load();
    api
      .get<{ accounts: AccountRow[] }>("/v1/whatsapp-accounts")
      .then((result) => setAccounts(campaignAccounts(result.accounts)))
      .catch((error: unknown) => toastError(errorText(error)));
  }, [load, toastError]);

  useEffect(() => {
    if (selectedId !== null) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  /** Depois de uma transição: detalhe fresco e lista com o estado novo. */
  const refresh = async (id: string) => {
    await Promise.all([loadDetail(id), load()]);
  };

  const toggleAccount = (id: string) => {
    setAccountIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    const limit = dailyLimit.trim() === "" ? null : Number(dailyLimit);
    try {
      const result = await api.post<{ campaign: Campaign; replayed: boolean }>(
        "/v1/campaigns",
        {
          name: name.trim(),
          messageTemplate,
          allowedAccountIds: accountIds,
          dailyLimit: limit,
        },
        { idempotencyKey: crypto.randomUUID() },
      );
      setCreating(false);
      setName("");
      setMessageTemplate("");
      setDailyLimit("");
      setAccountIds([]);
      setSelectedId(result.campaign.id);
      await load();
      show("Campanha criada");
    } catch (error) {
      toastError(errorText(error));
    }
  };

  const start = async (id: string) => {
    try {
      const body = { scheduledAt: scheduledAt === "" ? null : new Date(scheduledAt).toISOString() };
      const result = await api.post<{ recipientsCreated: number }>(
        `/v1/campaigns/${id}/start`,
        body,
        { idempotencyKey: crypto.randomUUID() },
      );
      setScheduledAt("");
      await refresh(id);
      show(`Campanha iniciada · ${result.recipientsCreated} destinatários`);
    } catch (error) {
      toastError(errorText(error));
    }
  };

  const pause = async (id: string) => {
    try {
      await api.post(`/v1/campaigns/${id}/pause`, {});
      await refresh(id);
      show("Campanha pausada");
    } catch (error) {
      toastError(errorText(error));
    }
  };

  const resume = async (id: string) => {
    try {
      await api.post(`/v1/campaigns/${id}/resume`, {});
      await refresh(id);
      show("Campanha retomada");
    } catch (error) {
      toastError(errorText(error));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-light text-fg">Campanhas</h1>
          <p className="mt-1 text-sm text-muted">
            Envios em massa com limites de ritmo, pausa automática e retoma humana.
          </p>
        </div>
        <Button
          variant="solid"
          onClick={() => setCreating(true)}
          disabled={campaignAccounts(accounts).length === 0}
          title={
            campaignAccounts(accounts).length === 0
              ? "Cria primeiro uma conta com objectivo Campanhas"
              : undefined
          }
        >
          Nova campanha
        </Button>
      </div>

      {items === null ? (
        <Spinner label="A carregar campanhas" />
      ) : items.length === 0 ? (
        <EmptyState
          title="Sem campanhas"
          description="Cria uma campanha para começar. O envio só acontece depois de a iniciares."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((campaign) => (
            <button
              key={campaign.id}
              type="button"
              onClick={() => setSelectedId(campaign.id === selectedId ? null : campaign.id)}
              className={`flex w-full items-center justify-between gap-4 border bg-surface px-4 py-3 text-left transition-colors ${
                campaign.id === selectedId ? "border-accent" : "border-border hover:border-accent/50"
              }`}
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm text-fg">{campaign.name}</span>
                <span className="text-xs text-muted">
                  {campaign.allowedAccountIds.length} conta(s) ·{" "}
                  {campaign.dailyLimit === null ? "sem limite diário" : `${campaign.dailyLimit}/dia`} ·{" "}
                  {relativeTime(campaign.createdAt)}
                </span>
              </span>
              <Badge tone={campaignTone(campaign.status)}>
                {campaignStatusLabel(campaign.status)}
              </Badge>
            </button>
          ))}
          {nextCursor !== null && (
            <Button variant="outline" onClick={() => void load(nextCursor)}>
              Carregar mais
            </Button>
          )}
        </div>
      )}

      {detail !== null && (
        <Card className="flex flex-col gap-4 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <h2 className="font-display text-lg text-fg">{detail.campaign.name}</h2>
              <Badge tone={campaignTone(detail.campaign.status)}>
                {campaignStatusLabel(detail.campaign.status)}
              </Badge>
            </div>
            {detail.campaign.pauseReason !== null && (
              <span className="text-sm text-warning">
                {campaignPauseReasonLabel(detail.campaign.pauseReason)}
              </span>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {(Object.keys(COUNT_LABELS) as Array<keyof CampaignCounts>).map((key) => (
              <Badge key={key} tone={COUNT_TONES[key]}>
                {COUNT_LABELS[key]}: {detail.counts[key]}
              </Badge>
            ))}
          </div>

          <div className="flex flex-col gap-1 text-sm text-muted">
            <span className="whitespace-pre-wrap break-words text-fg">
              {detail.campaign.messageTemplate}
            </span>
            <span>
              Contas:{" "}
              {detail.campaign.allowedAccountIds
                .map((id) => {
                  const account = accounts.find((a) => a.id === id);
                  return account === undefined
                    ? id
                    : `${account.label} (${accountStatusLabel(account.status)})`;
                })
                .join(", ")}
            </span>
            {detail.campaign.scheduledAt !== null && (
              <span>Agendada para {new Date(detail.campaign.scheduledAt).toLocaleString("pt-AO")}</span>
            )}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            {canStart(detail.campaign.status) && (
              <>
                <Field
                  label="Agendar (vazio = agora)"
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(event) => setScheduledAt(event.target.value)}
                />
                <Button variant="solid" onClick={() => void start(detail.campaign.id)}>
                  Iniciar
                </Button>
              </>
            )}
            {canPause(detail.campaign.status) && (
              <Button variant="outline" onClick={() => void pause(detail.campaign.id)}>
                Pausar
              </Button>
            )}
            {canResume(detail.campaign.status) && (
              <Button variant="solid" onClick={() => void resume(detail.campaign.id)}>
                Retomar
              </Button>
            )}
          </div>
        </Card>
      )}

      <Modal open={creating} title="Nova campanha" onClose={() => setCreating(false)}>
        <form onSubmit={(event) => void submitCreate(event)} className="flex flex-col gap-4">
          <Field
            label="Nome"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="campaign-template" className="text-sm text-muted">
              Mensagem
            </label>
            <textarea
              id="campaign-template"
              required
              rows={4}
              value={messageTemplate}
              onChange={(event) => setMessageTemplate(event.target.value)}
              placeholder="Olá {{nome}}, ..."
              className="border border-border bg-background px-3 py-2 text-fg"
            />
            <p className="text-xs text-muted">
              Usa {"{{nome}}"} para personalizar. O backend valida o modelo e acrescenta a forma de sair.
            </p>
          </div>
          <Field
            label="Limite diário (vazio = sem limite)"
            type="number"
            min={1}
            value={dailyLimit}
            onChange={(event) => setDailyLimit(event.target.value)}
          />
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm text-muted">Contas (objectivo Campanhas)</legend>
            {campaignAccounts(accounts).length === 0 ? (
              <p className="text-sm text-muted">
                Não há contas com objectivo Campanhas. Cria uma em Contas.
              </p>
            ) : (
              campaignAccounts(accounts).map((account) => (
                <label key={account.id} className="flex items-center gap-2 text-sm text-fg">
                  <input
                    type="checkbox"
                    checked={accountIds.includes(account.id)}
                    onChange={() => toggleAccount(account.id)}
                  />
                  {account.label} · {accountPurposeLabel(account.purpose)} ·{" "}
                  {accountStatusLabel(account.status)}
                </label>
              ))
            )}
          </fieldset>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="solid" disabled={accountIds.length === 0}>
              Criar
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
