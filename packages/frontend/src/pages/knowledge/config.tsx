// Configuração (Fase 2): perguntas de qualificação e gatilhos de handoff, com
// versionamento optimista (`expectedVersion` em PATCH/DELETE) e histórico de
// revisões reversível. Apagar é sempre pelo servidor — aqui só se pede.

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { BUSINESS_LINES } from "../../lib/knowledge";
import { relativeTime } from "../../lib/time";
import type {
  BusinessLineSlug,
  ConfigRevision,
  HandoffAction,
  HandoffTrigger,
  QualificationQuestion,
} from "../../lib/types";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { Field } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { Spinner } from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.detail ?? "Erro ao comunicar com o servidor";
  return "Erro inesperado";
}

const ACTIONS: Array<{ value: HandoffAction; label: string }> = [
  { value: "handoff_now", label: "Passar já a humano" },
  { value: "handoff_when_qualified", label: "Passar quando qualificado" },
  { value: "flag_only", label: "Só sinalizar" },
];

interface QuestionForm {
  line: BusinessLineSlug | "";
  key: string;
  question: string;
  answerType: "text" | "number" | "choice";
  choices: string;
  required: boolean;
  position: string;
  active: boolean;
}

const EMPTY_QUESTION: QuestionForm = {
  line: "software",
  key: "",
  question: "",
  answerType: "text",
  choices: "",
  required: false,
  position: "0",
  active: true,
};

interface TriggerForm {
  line: BusinessLineSlug | "";
  code: string;
  description: string;
  detectionHint: string;
  action: HandoffAction;
  priority: "normal" | "high" | "urgent";
  active: boolean;
}

const EMPTY_TRIGGER: TriggerForm = {
  line: "",
  code: "",
  description: "",
  detectionHint: "",
  action: "handoff_now",
  priority: "normal",
  active: true,
};

export function ConfigTab() {
  const { show, error: toastError } = useToast();
  const [questions, setQuestions] = useState<QualificationQuestion[] | null>(null);
  const [triggers, setTriggers] = useState<HandoffTrigger[] | null>(null);

  const [questionEdit, setQuestionEdit] = useState<QualificationQuestion | "new" | null>(null);
  const [questionForm, setQuestionForm] = useState<QuestionForm>(EMPTY_QUESTION);
  const [triggerEdit, setTriggerEdit] = useState<HandoffTrigger | "new" | null>(null);
  const [triggerForm, setTriggerForm] = useState<TriggerForm>(EMPTY_TRIGGER);

  const [revisions, setRevisions] = useState<{
    entityType: "qualification_question" | "handoff_trigger";
    entityId: string;
    version: number;
    items: ConfigRevision[];
  } | null>(null);

  const load = useCallback(() => {
    return Promise.all([
      api
        .get<{ items: QualificationQuestion[] }>("/v1/knowledge/qualification-questions", {
          includeInactive: "true",
        })
        .then((r) => setQuestions(r.items)),
      api
        .get<{ items: HandoffTrigger[] }>("/v1/knowledge/triggers", { includeInactive: "true" })
        .then((r) => setTriggers(r.items)),
    ]).catch((error: unknown) => toastError(errorText(error)));
  }, [toastError]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Perguntas ────────────────────────────────────────────────────────────
  const openQuestion = (item: QualificationQuestion | "new") => {
    setQuestionEdit(item);
    if (item === "new") {
      setQuestionForm(EMPTY_QUESTION);
    } else {
      setQuestionForm({
        line: "software",
        key: item.key,
        question: item.question,
        answerType: item.answerType,
        choices: Array.isArray(item.choices) ? item.choices.join(", ") : "",
        required: item.required,
        position: String(item.position),
        active: item.active,
      });
    }
  };

  const saveQuestion = async () => {
    if (questionEdit === null) return;
    const choices =
      questionForm.answerType === "choice"
        ? questionForm.choices.split(",").map((c) => c.trim()).filter(Boolean)
        : null;
    try {
      if (questionEdit === "new") {
        await api.post("/v1/knowledge/qualification-questions", {
          lineSlug: questionForm.line === "" ? "software" : questionForm.line,
          key: questionForm.key.trim(),
          question: questionForm.question.trim(),
          answerType: questionForm.answerType,
          ...(choices === null ? {} : { choices }),
          required: questionForm.required,
          position: Number(questionForm.position),
        });
      } else {
        await api.patch(`/v1/knowledge/qualification-questions/${questionEdit.id}`, {
          question: questionForm.question.trim(),
          answerType: questionForm.answerType,
          choices,
          required: questionForm.required,
          position: Number(questionForm.position),
          active: questionForm.active,
          expectedVersion: questionEdit.version,
        });
      }
      setQuestionEdit(null);
      show("Pergunta guardada");
      await load();
    } catch (error) {
      toastError(errorText(error));
    }
  };

  const removeQuestion = async (item: QualificationQuestion) => {
    try {
      await api.del(
        `/v1/knowledge/qualification-questions/${item.id}?expectedVersion=${item.version}`,
      );
      show("Pergunta eliminada");
      await load();
    } catch (error) {
      toastError(errorText(error));
    }
  };

  // ── Gatilhos ─────────────────────────────────────────────────────────────
  const openTrigger = (item: HandoffTrigger | "new") => {
    setTriggerEdit(item);
    if (item === "new") {
      setTriggerForm(EMPTY_TRIGGER);
    } else {
      setTriggerForm({
        line: (item.lineId === null ? "" : "software") as BusinessLineSlug | "",
        code: item.code,
        description: item.description,
        detectionHint: item.detectionHint,
        action: item.action,
        priority: item.priority,
        active: item.active,
      });
    }
  };

  const saveTrigger = async () => {
    if (triggerEdit === null) return;
    try {
      if (triggerEdit === "new") {
        await api.post("/v1/knowledge/triggers", {
          ...(triggerForm.line === "" ? {} : { lineSlug: triggerForm.line }),
          code: triggerForm.code.trim(),
          description: triggerForm.description.trim(),
          detectionHint: triggerForm.detectionHint.trim(),
          action: triggerForm.action,
          priority: triggerForm.priority,
          active: triggerForm.active,
        });
      } else {
        await api.patch(`/v1/knowledge/triggers/${triggerEdit.id}`, {
          description: triggerForm.description.trim(),
          detectionHint: triggerForm.detectionHint.trim(),
          action: triggerForm.action,
          priority: triggerForm.priority,
          active: triggerForm.active,
          expectedVersion: triggerEdit.version,
        });
      }
      setTriggerEdit(null);
      show("Gatilho guardado");
      await load();
    } catch (error) {
      toastError(errorText(error));
    }
  };

  const removeTrigger = async (item: HandoffTrigger) => {
    try {
      await api.del(`/v1/knowledge/triggers/${item.id}?expectedVersion=${item.version}`);
      show("Gatilho eliminado");
      await load();
    } catch (error) {
      toastError(errorText(error));
    }
  };

  // ── Revisões ─────────────────────────────────────────────────────────────
  const openRevisions = async (
    entityType: "qualification_question" | "handoff_trigger",
    entityId: string,
    version: number,
  ) => {
    try {
      const result = await api.get<{ items: ConfigRevision[] }>(
        "/v1/knowledge/config-revisions",
        { entityType, entityId },
      );
      setRevisions({ entityType, entityId, version, items: result.items });
    } catch (error) {
      toastError(errorText(error));
    }
  };

  const revert = async (revision: ConfigRevision) => {
    if (revisions === null) return;
    try {
      await api.post(`/v1/knowledge/config-revisions/${revision.id}/revert`, {
        expectedVersion: revisions.version,
      });
      setRevisions(null);
      show("Revisão revertida");
      await load();
    } catch (error) {
      toastError(errorText(error));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-3 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-lg text-fg">Perguntas de qualificação</h2>
          <Button variant="solid" onClick={() => openQuestion("new")}>
            Nova pergunta
          </Button>
        </div>
        {questions === null ? (
          <Spinner label="A carregar perguntas" />
        ) : questions.length === 0 ? (
          <EmptyState title="Sem perguntas" description="Acrescenta o que a IA deve qualificar." />
        ) : (
          questions.map((item) => (
            <div
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-3 border border-border bg-background px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-fg">{item.question}</span>
                  <Badge tone={item.active ? "success" : "neutral"}>
                    {item.active ? "Activa" : "Inactiva"}
                  </Badge>
                  <span className="text-xs text-muted">
                    {item.key} · v{item.version}
                  </span>
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => openQuestion(item)}>
                  Editar
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void openRevisions("qualification_question", item.id, item.version)}
                >
                  Revisões
                </Button>
                <Button variant="ghost" onClick={() => void removeQuestion(item)}>
                  Eliminar
                </Button>
              </div>
            </div>
          ))
        )}
      </Card>

      <Card className="flex flex-col gap-3 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-lg text-fg">Gatilhos de handoff</h2>
          <Button variant="solid" onClick={() => openTrigger("new")}>
            Novo gatilho
          </Button>
        </div>
        {triggers === null ? (
          <Spinner label="A carregar gatilhos" />
        ) : triggers.length === 0 ? (
          <EmptyState title="Sem gatilhos" description="Sem gatilhos, a IA nunca passa a conversa a um humano." />
        ) : (
          triggers.map((item) => (
            <div
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-3 border border-border bg-background px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-fg">{item.description}</span>
                  <Badge tone={item.active ? "success" : "neutral"}>
                    {item.active ? "Activo" : "Inactivo"}
                  </Badge>
                  <Badge tone={item.priority === "urgent" ? "danger" : item.priority === "high" ? "warning" : "neutral"}>
                    {item.priority}
                  </Badge>
                  <span className="text-xs text-muted">
                    {item.code} · v{item.version}
                  </span>
                </div>
                <p className="text-xs text-muted">{item.detectionHint}</p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => openTrigger(item)}>
                  Editar
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void openRevisions("handoff_trigger", item.id, item.version)}
                >
                  Revisões
                </Button>
                <Button variant="ghost" onClick={() => void removeTrigger(item)}>
                  Eliminar
                </Button>
              </div>
            </div>
          ))
        )}
      </Card>

      <Modal
        open={questionEdit !== null}
        title={questionEdit === "new" ? "Nova pergunta" : "Editar pergunta"}
        onClose={() => setQuestionEdit(null)}
      >
        <div className="flex flex-col gap-3">
          {questionEdit === "new" && (
            <>
              <label htmlFor="question-line" className="text-sm text-muted">
                Linha
              </label>
              <select
                id="question-line"
                value={questionForm.line}
                onChange={(event) =>
                  setQuestionForm((prev) => ({
                    ...prev,
                    line: event.target.value as BusinessLineSlug,
                  }))
                }
                className="border border-border bg-background px-3 py-2 text-fg"
              >
                {BUSINESS_LINES.map((line) => (
                  <option key={line.slug} value={line.slug}>
                    {line.label}
                  </option>
                ))}
              </select>
              <Field
                label="Chave (a–z, 3–40)"
                value={questionForm.key}
                onChange={(event) =>
                  setQuestionForm((prev) => ({ ...prev, key: event.target.value }))
                }
              />
            </>
          )}
          <Field
            label="Pergunta"
            value={questionForm.question}
            onChange={(event) =>
              setQuestionForm((prev) => ({ ...prev, question: event.target.value }))
            }
          />
          <label htmlFor="question-type" className="text-sm text-muted">
            Tipo de resposta
          </label>
          <select
            id="question-type"
            value={questionForm.answerType}
            onChange={(event) =>
              setQuestionForm((prev) => ({
                ...prev,
                answerType: event.target.value as QuestionForm["answerType"],
              }))
            }
            className="border border-border bg-background px-3 py-2 text-fg"
          >
            <option value="text">Texto</option>
            <option value="number">Número</option>
            <option value="choice">Escolha</option>
          </select>
          {questionForm.answerType === "choice" && (
            <Field
              label="Opções (separadas por vírgula)"
              value={questionForm.choices}
              onChange={(event) =>
                setQuestionForm((prev) => ({ ...prev, choices: event.target.value }))
              }
            />
          )}
          <Field
            label="Posição"
            type="number"
            value={questionForm.position}
            onChange={(event) =>
              setQuestionForm((prev) => ({ ...prev, position: event.target.value }))
            }
          />
          <label className="flex items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={questionForm.required}
              onChange={(event) =>
                setQuestionForm((prev) => ({ ...prev, required: event.target.checked }))
              }
            />
            Obrigatória
          </label>
          {questionEdit !== "new" && (
            <label className="flex items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                checked={questionForm.active}
                onChange={(event) =>
                  setQuestionForm((prev) => ({ ...prev, active: event.target.checked }))
                }
              />
              Activa
            </label>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setQuestionEdit(null)}>
              Cancelar
            </Button>
            <Button variant="solid" onClick={() => void saveQuestion()}>
              Guardar
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={triggerEdit !== null}
        title={triggerEdit === "new" ? "Novo gatilho" : "Editar gatilho"}
        onClose={() => setTriggerEdit(null)}
      >
        <div className="flex flex-col gap-3">
          {triggerEdit === "new" && (
            <>
              <label htmlFor="trigger-line" className="text-sm text-muted">
                Linha (vazio = global)
              </label>
              <select
                id="trigger-line"
                value={triggerForm.line}
                onChange={(event) =>
                  setTriggerForm((prev) => ({
                    ...prev,
                    line: event.target.value as BusinessLineSlug | "",
                  }))
                }
                className="border border-border bg-background px-3 py-2 text-fg"
              >
                <option value="">Global</option>
                {BUSINESS_LINES.map((line) => (
                  <option key={line.slug} value={line.slug}>
                    {line.label}
                  </option>
                ))}
              </select>
              <Field
                label="Código (ex.: PURCHASE_INTENT)"
                value={triggerForm.code}
                onChange={(event) =>
                  setTriggerForm((prev) => ({ ...prev, code: event.target.value }))
                }
              />
            </>
          )}
          <Field
            label="Descrição"
            value={triggerForm.description}
            onChange={(event) =>
              setTriggerForm((prev) => ({ ...prev, description: event.target.value }))
            }
          />
          <label htmlFor="trigger-hint" className="text-sm text-muted">
            Como a IA o reconhece
          </label>
          <textarea
            id="trigger-hint"
            rows={4}
            value={triggerForm.detectionHint}
            onChange={(event) =>
              setTriggerForm((prev) => ({ ...prev, detectionHint: event.target.value }))
            }
            className="border border-border bg-background px-3 py-2 text-sm text-fg"
          />
          <label htmlFor="trigger-action" className="text-sm text-muted">
            Acção
          </label>
          <select
            id="trigger-action"
            value={triggerForm.action}
            onChange={(event) =>
              setTriggerForm((prev) => ({
                ...prev,
                action: event.target.value as HandoffAction,
              }))
            }
            className="border border-border bg-background px-3 py-2 text-fg"
          >
            {ACTIONS.map((action) => (
              <option key={action.value} value={action.value}>
                {action.label}
              </option>
            ))}
          </select>
          <label htmlFor="trigger-priority" className="text-sm text-muted">
            Prioridade
          </label>
          <select
            id="trigger-priority"
            value={triggerForm.priority}
            onChange={(event) =>
              setTriggerForm((prev) => ({
                ...prev,
                priority: event.target.value as TriggerForm["priority"],
              }))
            }
            className="border border-border bg-background px-3 py-2 text-fg"
          >
            <option value="normal">Normal</option>
            <option value="high">Alta</option>
            <option value="urgent">Urgente</option>
          </select>
          <label className="flex items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={triggerForm.active}
              onChange={(event) =>
                setTriggerForm((prev) => ({ ...prev, active: event.target.checked }))
              }
            />
            Activo
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setTriggerEdit(null)}>
              Cancelar
            </Button>
            <Button variant="solid" onClick={() => void saveTrigger()}>
              Guardar
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={revisions !== null} title="Revisões" onClose={() => setRevisions(null)}>
        <div className="flex flex-col gap-2">
          {(revisions?.items ?? []).length === 0 ? (
            <p className="text-sm text-muted">Sem revisões registadas.</p>
          ) : (
            revisions?.items.map((revision) => (
              <div
                key={revision.id}
                className="flex items-center justify-between gap-2 border border-border px-3 py-2"
              >
                <span className="text-sm text-fg">
                  v{revision.version} · {relativeTime(revision.createdAt)}
                  {revision.note !== null && <span className="ml-2 text-xs text-muted">{revision.note}</span>}
                </span>
                <Button variant="ghost" onClick={() => void revert(revision)}>
                  Reverter
                </Button>
              </div>
            ))
          )}
        </div>
      </Modal>
    </div>
  );
}
