// Definições (Onda 1, Task 11): mudar a própria password e activar o TOTP.
// Contratos reais (adapters/http/routes/auth.ts):
// - POST /v1/auth/password {currentPassword,newPassword} → 204; revoga as
//   OUTRAS sessões e mantém a actual (login.ts:112) — por isso o modal de
//   confirmação avisa antes de enviar.
// - POST /v1/auth/totp/setup → {otpauthUrl}; POST /v1/auth/totp/verify {code}
//   → {ok:true} — o MESMO fluxo do login (componente TotpSetup extraído).
// Sem rota para desactivar TOTP: a nota é honesta (labels.TOTP_DISABLE_NOTE).

import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import {
  OWN_PASSWORD_SESSIONS_WARNING,
  PASSWORD_CHANGED_MESSAGE,
  PASSWORD_HINT,
  TOTP_DISABLE_NOTE,
  TOTP_ENABLED_MESSAGE,
  passwordChangeErrorText,
  totpErrorText,
} from "../lib/labels";
import { TotpSetup } from "../components/TotpSetup";
import { Button } from "../components/ui/Button";
import { Field } from "../components/ui/Field";
import { Modal } from "../components/ui/Modal";
import { useToast } from "../components/ui/Toast";

export default function SettingsPage() {
  const { show } = useToast();

  // Palavra-passe própria
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  // TOTP
  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null);
  const [totpBusy, setTotpBusy] = useState(false);
  const [totpError, setTotpError] = useState<string | null>(null);

  const openConfirmation = (event: FormEvent) => {
    event.preventDefault();
    setPasswordError(null);
    setConfirming(true);
  };

  const changePassword = async () => {
    if (submitting) return;
    setSubmitting(true);
    setPasswordError(null);
    try {
      await api.post("/v1/auth/password", { currentPassword, newPassword });
      setConfirming(false);
      setCurrentPassword("");
      setNewPassword("");
      show(PASSWORD_CHANGED_MESSAGE);
    } catch (error) {
      // o modal fica aberto: o utilizador corrige sem reescrever tudo
      setPasswordError(passwordChangeErrorText(error));
    } finally {
      setSubmitting(false);
    }
  };

  const startTotpSetup = async () => {
    if (totpBusy) return;
    setTotpBusy(true);
    setTotpError(null);
    try {
      const result = await api.post<{ otpauthUrl: string }>("/v1/auth/totp/setup");
      setOtpauthUrl(result.otpauthUrl);
    } catch (error) {
      setTotpError(totpErrorText(error));
    } finally {
      setTotpBusy(false);
    }
  };

  const verifyTotpCode = async (code: string) => {
    if (totpBusy) return;
    setTotpBusy(true);
    setTotpError(null);
    try {
      await api.post<{ ok: true }>("/v1/auth/totp/verify", { code });
      setOtpauthUrl(null);
      show(TOTP_ENABLED_MESSAGE);
    } catch (error) {
      setTotpError(totpErrorText(error));
    } finally {
      setTotpBusy(false);
    }
  };

  return (
    <div className="flex max-w-lg flex-col gap-8">
      <div>
        <h1 className="font-display text-2xl font-light text-fg">Definições</h1>
        <p className="mt-1 text-sm text-muted">
          A tua conta: palavra-passe e autenticação de dois factores.
        </p>
      </div>

      <section aria-labelledby="password-heading" className="border border-border bg-surface p-6">
        <h2 id="password-heading" className="font-display text-xl font-light text-fg">
          Palavra-passe
        </h2>
        <form onSubmit={openConfirmation} className="mt-4 flex flex-col gap-4">
          <Field
            label="Palavra-passe actual"
            type="password"
            required
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
          <Field
            label="Nova palavra-passe"
            type="password"
            required
            autoComplete="new-password"
            aria-describedby="new-password-hint"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
          <p id="new-password-hint" className="text-xs text-muted">
            {PASSWORD_HINT}
          </p>
          <div>
            <Button type="submit" variant="solid">
              Mudar palavra-passe
            </Button>
          </div>
        </form>
      </section>

      <section aria-labelledby="totp-heading" className="border border-border bg-surface p-6">
        <h2 id="totp-heading" className="font-display text-xl font-light text-fg">
          Autenticação de dois factores
        </h2>
        <p className="mt-1 text-sm text-muted">
          Protege a tua conta com uma app de autenticação (Google Authenticator, Authy…).
        </p>
        <div className="mt-4">
          {otpauthUrl === null ? (
            <Button variant="solid" disabled={totpBusy} onClick={() => void startTotpSetup()}>
              Activar TOTP
            </Button>
          ) : (
            <TotpSetup otpauthUrl={otpauthUrl} onSubmit={(code) => void verifyTotpCode(code)} />
          )}
          {totpError !== null && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {totpError}
            </p>
          )}
        </div>
        <p className="mt-4 text-xs text-muted">{TOTP_DISABLE_NOTE}</p>
      </section>

      <Modal
        open={confirming}
        title="Mudar palavra-passe"
        onClose={() => {
          if (!submitting) setConfirming(false);
        }}
      >
        <p className="text-sm text-muted">{OWN_PASSWORD_SESSIONS_WARNING}</p>
        {passwordError !== null && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {passwordError}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" disabled={submitting} onClick={() => setConfirming(false)}>
            Cancelar
          </Button>
          <Button variant="solid" disabled={submitting} onClick={() => void changePassword()}>
            {submitting ? "A concluir…" : "Confirmar"}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
