// Formulário de TOTP (Onda 1, Task 11): extraído do ecrã mfa_setup/mfa_required
// do login.tsx para reutilizar o MESMO fluxo em /settings — QR (quando há
// otpauthUrl), campo de código de 6 dígitos e submissão validada. O erro e as
// acções extra (ex.: "Usar outra conta") são do chamador (children).

import { useState, type FormEvent, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "./ui/Button";
import { Field } from "./ui/Field";

export function TotpSetup({
  otpauthUrl,
  onSubmit,
  submitLabel = "Confirmar",
  children,
}: {
  otpauthUrl: string | null;
  onSubmit: (code: string) => void;
  submitLabel?: string;
  children?: ReactNode;
}) {
  const [code, setCode] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) return;
    onSubmit(code);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {otpauthUrl !== null && (
        <div className="flex flex-col items-center gap-3">
          <QRCodeSVG value={otpauthUrl} size={176} bgColor="#ffffff" fgColor="#0a0a0c" />
          <p className="text-center text-xs text-muted">
            Activa o TOTP: escaneia o código com a tua app de autenticação (Google
            Authenticator, Authy…)
          </p>
        </div>
      )}
      <Field
        label="Código de confirmação"
        inputMode="numeric"
        maxLength={6}
        pattern="\d{6}"
        required
        autoComplete="one-time-code"
        value={code}
        onChange={(event) => setCode(event.target.value)}
      />
      <Button type="submit" variant="solid">
        {submitLabel}
      </Button>
      {children}
    </form>
  );
}
