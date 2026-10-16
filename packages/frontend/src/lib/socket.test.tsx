// Cliente de eventos do painel (Task 3 do plano do frontend): subscribe /
// unsubscribe sobre um socket injectado e o hook useEvent com cleanup.
// O emitter é falso — testamos a mecânica da nossa camada, não o socket.io.

import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPanelSocket, PanelSocketProvider, useEvent, type SocketLike } from "./socket";

function fakeSocket() {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const offCalls: string[] = [];
  return {
    on(event: string, handler: (payload: unknown) => void): void {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    off(event: string, handler: (payload: unknown) => void): void {
      offCalls.push(event);
      handlers.get(event)?.delete(handler);
    },
    disconnect(): void {
      /* não testado aqui */
    },
    emit(event: string, payload: unknown): void {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
    offCalls,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createPanelSocket", () => {
  it("subscricao recebe o payload do evento", () => {
    const fake = fakeSocket();
    const panel = createPanelSocket(() => fake as unknown as SocketLike);
    const handler = vi.fn();
    panel.on("message.created", handler);

    const payload = { v: 1, messageId: "m1", conversationId: "c1", accountId: "a1", sender: "human", status: "queued" };
    fake.emit("message.created", payload);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it("unsubscribe deixa de receber", () => {
    const fake = fakeSocket();
    const panel = createPanelSocket(() => fake as unknown as SocketLike);
    const handler = vi.fn();
    const off = panel.on("account.status", handler);
    off();

    fake.emit("account.status", { v: 1, accountId: "a1", status: "connected" });

    expect(handler).not.toHaveBeenCalled();
    expect(fake.offCalls).toContain("account.status");
  });
});

describe("useEvent", () => {
  it("useEvent renova a subscricao no cleanup", () => {
    const fake = fakeSocket();
    const panel = createPanelSocket(() => fake as unknown as SocketLike);
    const handler = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <PanelSocketProvider socket={panel}>{children}</PanelSocketProvider>
    );

    const { unmount } = renderHook(() => useEvent("message.status", handler), { wrapper });
    fake.emit("message.status", { v: 1, messageId: "m1", status: "sent" });
    expect(handler).toHaveBeenCalledTimes(1);

    unmount();
    fake.emit("message.status", { v: 1, messageId: "m1", status: "delivered" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(fake.offCalls).toContain("message.status");
  });
});
