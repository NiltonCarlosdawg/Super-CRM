import { useId, type InputHTMLAttributes } from "react";

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  /** Se presente, o campo é marcado inválido e a mensagem aparece em role=alert. */
  error?: string;
}

export function Field({ label, error, id, className = "", ...rest }: FieldProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={fieldId} className="text-sm text-muted">
        {label}
      </label>
      <input
        id={fieldId}
        aria-invalid={error !== undefined ? "true" : undefined}
        className={`border border-border bg-background px-3 py-2 text-fg placeholder:text-muted/60 ${className}`}
        {...rest}
      />
      {error !== undefined && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
