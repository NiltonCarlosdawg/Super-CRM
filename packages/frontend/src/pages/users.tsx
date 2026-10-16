// Gestão de utilizadores (Task 11): tabela com papel+estado, criação em modal
// (a política de password é do servidor — 12–100 caracteres, password.ts — e a
// dica vive no campo), acções desactivadas na linha do próprio (o backend
// recusa cannot_modify_self, users.ts:75-77) e 409 last_admin/email já
// registado em toast. Só admin chega aqui (RequireAdmin na rota, main.tsx:39).

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useSession } from "../lib/auth";
import { api, ApiError } from "../lib/api";
import { roleLabel, userStatusLabel } from "../lib/labels";
import type { Role, UserSummary } from "../lib/types";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Field } from "../components/ui/Field";
import { Modal } from "../components/ui/Modal";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";

const ROLES: Role[] = ["agent", "editor", "admin"];

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.detail ?? "Erro ao comunicar com o servidor";
  return "Erro inesperado";
}

export default function UsersPage() {
  const { user: sessionUser } = useSession();
  const { show, error: toastError } = useToast();
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("agent");
  const [password, setPassword] = useState("");

  const load = useCallback(() => {
    return api
      .get<{ users: UserSummary[] }>("/v1/users")
      .then((result) => {
        setUsers(result.users);
      })
      .catch((error: unknown) => {
        toastError(errorText(error));
      });
  }, [toastError]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyUser = (updated: UserSummary) => {
    setUsers((prev) =>
      prev === null ? prev : prev.map((user) => (user.id === updated.id ? updated : user)),
    );
  };

  const patch = (id: string, body: { role?: Role; active?: boolean }) => {
    api
      .patch<{ user: UserSummary }>(`/v1/users/${id}`, body)
      .then((result) => applyUser(result.user))
      .catch((error: unknown) => {
        toastError(errorText(error));
        void load(); // ex.: last_admin recusado — repor o estado real do servidor
      });
  };

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const result = await api.post<{ user: UserSummary }>("/v1/users", {
        name: name.trim(),
        email: email.trim(),
        role,
        password,
      });
      setUsers((prev) => [...(prev ?? []), result.user]);
      setCreating(false);
      setName("");
      setEmail("");
      setRole("agent");
      setPassword("");
      show("Utilizador criado");
    } catch (error) {
      toastError(errorText(error));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-light text-fg">Utilizadores</h1>
          <p className="mt-1 text-sm text-muted">
            Quem tem acesso ao painel: papel, estado e criação de contas.
          </p>
        </div>
        <Button variant="solid" onClick={() => setCreating(true)}>
          Novo utilizador
        </Button>
      </div>

      {users === null ? (
        <Spinner label="A carregar utilizadores" />
      ) : users.length === 0 ? (
        <EmptyState
          title="Sem utilizadores"
          description="Cria a primeira conta para começar."
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
              {users.map((user) => {
                const isSelf = user.id === sessionUser?.id;
                return (
                  <tr key={user.id} className="border-b border-border/60 last:border-b-0">
                    <td className="px-4 py-3 text-fg">
                      {user.name}
                      {isSelf && <span className="ml-2 text-xs text-muted">(tu)</span>}
                    </td>
                    <td className="px-4 py-3 text-muted">{user.email}</td>
                    <td className="px-4 py-3">
                      <select
                        aria-label={`Papel de ${user.name}`}
                        value={user.role}
                        disabled={isSelf}
                        onChange={(event) =>
                          patch(user.id, { role: event.target.value as Role })
                        }
                        className="border border-border bg-background px-2 py-1 text-fg disabled:opacity-60"
                      >
                        {ROLES.map((option) => (
                          <option key={option} value={option}>
                            {roleLabel(option)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2">
                        <Badge tone={user.active ? "success" : "neutral"}>
                          {userStatusLabel(user.active)}
                        </Badge>
                        {!isSelf && (
                          <Button
                            variant="outline"
                            className="px-2 py-1 text-xs"
                            aria-label={`${user.active ? "Desactivar" : "Activar"} ${user.name}`}
                            onClick={() => patch(user.id, { active: !user.active })}
                          >
                            {user.active ? "Desactivar" : "Activar"}
                          </Button>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={creating} title="Novo utilizador" onClose={() => setCreating(false)}>
        <form onSubmit={(event) => void submitCreate(event)} className="flex flex-col gap-4">
          <Field
            label="Nome"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Field
            label="Email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="user-role" className="text-sm text-muted">
              Papel
            </label>
            <select
              id="user-role"
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
              className="border border-border bg-background px-3 py-2 text-fg"
            >
              {ROLES.map((option) => (
                <option key={option} value={option}>
                  {roleLabel(option)}
                </option>
              ))}
            </select>
          </div>
          <Field
            label="Palavra-passe"
            type="password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby="password-hint"
          />
          <p id="password-hint" className="text-xs text-muted">
            Mínimo de 12 caracteres (a validação é feita no servidor).
          </p>
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
    </div>
  );
}
