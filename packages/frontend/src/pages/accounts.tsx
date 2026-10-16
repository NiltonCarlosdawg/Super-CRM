// Página de contas WhatsApp (Task 7): lista com estado+telefone, detalhe com
// QR vivo enquanto "A ligar" (poll de 4s + refetch imediato no evento
// account.status), criar conta e desligar com confirmação. Contratos reais:
// GET/POST /v1/whatsapp-accounts, GET :id → {account, qr?}, POST :id/logout.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useEvent } from "../lib/socket";
import { api, ApiError } from "../lib/api";
import { accountPurposeLabel, accountStatusLabel } from "../lib/labels";
import type { AccountPurpose, AccountRow, AccountStatus } from "../lib/types";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Field } from "../components/ui/Field";
import { Modal } from "../components/ui/Modal";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";

export function accountTone(status: AccountStatus): BadgeTone {
  switch (status) {
    case "connecting":
      return "info";
    case "connected":
      return "success";
    case "disconnected":
      return "neutral";
    case "suspected_ban":
      return "danger";
  }
}

const PURPOSES: AccountPurpose[] = ["support", "sales", "campaigns"];

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.detail ?? "Erro ao comunicar com o servidor";
  return "Erro inesperado";
}

/**
 * QR da conta: poll imediato + de 4s enquanto `connecting`, pára em qualquer
 * outro estado; o evento account.status força refetch (QR do WhatsApp rotaciona).
 */
export function useAccountQr(
  id: string | null,
  status: AccountStatus | null,
): { qr: string | null } {
  const [qr, setQr] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (id === null) return;
    api
      .get<{ qr?: string }>(`/v1/whatsapp-accounts/${id}`)
      .then((detail) => setQr(detail.qr ?? null))
      .catch(() => {
        // Erros do detalhe não podem matar a página — o QR fica inalterado.
      });
  }, [id]);

  useEffect(() => {
    if (id === null || status !== "connecting") return;
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [id, status, refresh]);

  useEvent("account.status", (payload) => {
    if (payload.accountId === id) refresh();
  });

  return { qr };
}

export default function AccountsPage() {
  const { show, error: toastError } = useToast();
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const [label, setLabel] = useState("");
  const [purpose, setPurpose] = useState<AccountPurpose>("support");

  const load = useCallback(() => {
    return api
      .get<{ accounts: AccountRow[] }>("/v1/whatsapp-accounts")
      .then((result) => {
        setAccounts(result.accounts);
      })
      .catch((error: unknown) => {
        toastError(errorText(error));
      });
  }, [toastError]);

  useEffect(() => {
    void load();
  }, [load]);

  // Estado da lista acompanha o tempo real (a ligação muda sem novo GET).
  useEvent("account.status", (payload) => {
    setAccounts((prev) =>
      prev === null
        ? prev
        : prev.map((account) =>
            account.id === payload.accountId
              ? { ...account, status: payload.status }
              : account,
          ),
    );
    if (payload.status === "connected") void load(); // telefone só existe depois de ligar
  });

  const selected = accounts?.find((account) => account.id === selectedId) ?? null;
  const { qr } = useAccountQr(selectedId, selected?.status ?? null);

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = label.trim();
    if (trimmed === "") return;
    try {
      const result = await api.post<{ account: AccountRow }>("/v1/whatsapp-accounts", {
        label: trimmed,
        purpose,
      });
      setAccounts((prev) => [result.account, ...(prev ?? [])]);
      setCreating(false);
      setLabel("");
      setSelectedId(result.account.id); // criar → abre detalhe
    } catch (error) {
      toastError(errorText(error));
    }
  };

  const submitLogout = async () => {
    if (selectedId === null) return;
    try {
      await api.post(`/v1/whatsapp-accounts/${selectedId}/logout`);
      setConfirmingLogout(false);
      await load();
      show("Conta desligada");
    } catch (error) {
      toastError(errorText(error));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-light text-fg">Contas WhatsApp</h1>
          <p className="mt-1 text-sm text-muted">
            Números ligados ao painel: estado, QR e desligamento.
          </p>
        </div>
        <Button variant="solid" onClick={() => setCreating(true)}>
          Criar conta
        </Button>
      </div>

      {accounts === null ? (
        <Spinner label="A carregar contas" />
      ) : accounts.length === 0 ? (
        <EmptyState
          title="Sem contas WhatsApp"
          description="Cria a primeira conta para começar a receber mensagens."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {accounts.map((account) => (
            <button
              key={account.id}
              type="button"
              onClick={() => setSelectedId(account.id === selectedId ? null : account.id)}
              className={`flex w-full items-center justify-between gap-4 border bg-surface px-4 py-3 text-left transition-colors ${
                account.id === selectedId ? "border-accent" : "border-border hover:border-accent/50"
              }`}
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm text-fg">{account.label}</span>
                <span className="text-xs text-muted">
                  {account.phoneE164 ?? "Sem número"} · {accountPurposeLabel(account.purpose)}
                </span>
              </span>
              <Badge tone={accountTone(account.status)}>{accountStatusLabel(account.status)}</Badge>
            </button>
          ))}
        </div>
      )}

      {selected !== null && (
        <Card className="flex flex-col gap-4 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <h2 className="font-display text-lg text-fg">{selected.label}</h2>
              <Badge tone={accountTone(selected.status)}>
                {accountStatusLabel(selected.status)}
              </Badge>
            </div>
            <span className="text-sm text-muted">
              {accountPurposeLabel(selected.purpose)} ·{" "}
              {selected.phoneE164 ?? "Sem número"}
            </span>
          </div>

          {selected.status === "connecting" ? (
            <div className="flex flex-col items-center gap-3">
              {qr !== null ? (
                <>
                  <QRCodeSVG value={qr} size={200} bgColor="#ffffff" fgColor="#0a0a0c" />
                  <p className="max-w-sm text-center text-xs text-muted">
                    Abre o WhatsApp do número e escaneia o código. O QR renova sozinho enquanto a
                    conta está a ligar.
                  </p>
                </>
              ) : (
                <Spinner label="A aguardar o QR" />
              )}
            </div>
          ) : (
            <p className="text-sm text-muted">
              {selected.status === "connected" && `Número ligado: ${selected.phoneE164 ?? "—"}`}
              {selected.status === "disconnected" && "Conta desligada do painel."}
              {selected.status === "suspected_ban" &&
                "O WhatsApp desta conta suspeita de bloqueio — não há reposição automática nesta fase (decisão humana)."}
            </p>
          )}

          {selected.status !== "disconnected" && (
            <div className="flex justify-end">
              <Button variant="outline" onClick={() => setConfirmingLogout(true)}>
                Desligar conta
              </Button>
            </div>
          )}
        </Card>
      )}

      <Modal open={creating} title="Criar conta" onClose={() => setCreating(false)}>
        <form onSubmit={(event) => void submitCreate(event)} className="flex flex-col gap-4">
          <Field
            label="Nome da conta"
            required
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="account-purpose" className="text-sm text-muted">
              Objectivo da conta
            </label>
            <select
              id="account-purpose"
              value={purpose}
              onChange={(event) => setPurpose(event.target.value as AccountPurpose)}
              className="border border-border bg-background px-3 py-2 text-fg"
            >
              {PURPOSES.map((option) => (
                <option key={option} value={option}>
                  {accountPurposeLabel(option)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="solid">
              Criar
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={confirmingLogout && selected !== null}
        title="Desligar conta"
        onClose={() => setConfirmingLogout(false)}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            Desligar <span className="text-fg">{selected?.label}</span>? A conta sai do painel até
            voltar a ser emparelhada.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmingLogout(false)}>
              Cancelar
            </Button>
            <Button variant="solid" onClick={() => void submitLogout()}>
              Desligar
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
