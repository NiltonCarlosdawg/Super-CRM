// Teste (Fase 2, Task 2): corre o orquestrador contra o rascunho ou o
// conhecimento publicado, com a linha opcional. É um teste real: não envia
// WhatsApp nem dispara handoff (isTest no backend). Mostra resposta e fontes.

import { useState, type FormEvent } from "react";
import { api, ApiError } from "../../lib/api";
import { BUSINESS_LINES } from "../../lib/knowledge";
import type { BusinessLineSlug, ChatTestResult } from "../../lib/types";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { useToast } from "../../components/ui/Toast";

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.detail ?? "Erro ao comunicar com o servidor";
  return "Erro inesperado";
}

export function TestTab() {
  const { error: toastError } = useToast();
  const [text, setText] = useState("");
  const [target, setTarget] = useState<"draft" | "published">("published");
  const [line, setLine] = useState<BusinessLineSlug | "">("");
  const [result, setResult] = useState<ChatTestResult | null>(null);
  const [running, setRunning] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (text.trim() === "") return;
    setRunning(true);
    try {
      const response = await api.post<ChatTestResult>("/v1/knowledge/chat/test", {
        text: text.trim(),
        target,
        ...(target === "published" && line !== "" ? { lineSlug: line } : {}),
      });
      setResult(response);
    } catch (error) {
      toastError(errorText(error));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-3 p-6">
        <h2 className="font-display text-lg text-fg">Perguntar à IA</h2>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
          <label htmlFor="chat-text" className="text-sm text-muted">
            Pergunta
          </label>
          <textarea
            id="chat-text"
            rows={3}
            required
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="border border-border bg-background px-3 py-2 text-sm text-fg"
          />
          <label htmlFor="chat-target" className="text-sm text-muted">
            Conhecimento usado
          </label>
          <select
            id="chat-target"
            value={target}
            onChange={(event) => setTarget(event.target.value as "draft" | "published")}
            className="border border-border bg-background px-3 py-2 text-fg"
          >
            <option value="published">Publicado</option>
            <option value="draft">Rascunho (o que estás a treinar)</option>
          </select>
          {target === "published" && (
            <>
              <label htmlFor="chat-line" className="text-sm text-muted">
                Linha de negócio (opcional)
              </label>
              <select
                id="chat-line"
                value={line}
                onChange={(event) => setLine(event.target.value as BusinessLineSlug | "")}
                className="border border-border bg-background px-3 py-2 text-fg"
              >
                <option value="">Sem linha (só documentos globais)</option>
                {BUSINESS_LINES.map((item) => (
                  <option key={item.slug} value={item.slug}>
                    {item.label}
                  </option>
                ))}
              </select>
            </>
          )}
          <div>
            <Button type="submit" variant="solid" disabled={running}>
              {running ? "A pensar…" : "Testar"}
            </Button>
          </div>
        </form>
      </Card>

      {result !== null && (
        <Card className="flex flex-col gap-3 p-6">
          <h2 className="font-display text-lg text-fg">Resposta</h2>
          <p className="whitespace-pre-wrap text-sm text-fg">
            {result.reply ?? "(a IA não respondeu)"}
          </p>
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase text-muted">Fontes</span>
            {result.sources.length === 0 ? (
              <p className="text-sm text-muted">Sem fontes — resposta sem apoio no conhecimento.</p>
            ) : (
              result.sources.map((source) => (
                <div key={`${source.type}:${source.id}`} className="flex items-center gap-2 text-sm">
                  <Badge tone="neutral">{source.type}</Badge>
                  <span className="text-muted">{source.id}</span>
                  {source.version !== undefined && (
                    <span className="text-xs text-muted">v{source.version}</span>
                  )}
                  {source.score !== undefined && (
                    <span className="text-xs text-muted">{source.score.toFixed(3)}</span>
                  )}
                </div>
              ))
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
