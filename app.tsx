import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  definePluginApp,
  useBbContext,
  useRpc,
  type PluginAppBuilder,
  type PluginRpcClient,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { suppressTouchCompatibilityClick } from "./lib/touch-click";
import {
  DEFAULT_PLAN_PROMPT,
  markerForState,
  planModeRequestTarget,
  withPlanModeMarker,
  type ThreadPlanState,
} from "./lib/plan-mode-input";

const OVERLAY_ID = "plan-mode-border-overlay";
const PROMPTBOX_SELECTOR = "form[data-promptbox], [data-promptbox], [data-promptbox-shell]";
const DEFAULT_IMPLEMENT_PROMPT = "approved";

type RpcClient = PluginRpcClient<typeof rpcContract>;

// Shared by every composer in this window and by the fetch hook, which reads
// it at send time. A null thread id is the new-chat composer.
const threadStates = new Map<string, ThreadPlanState>();
let newThreadEnabled = false;
let newThreadDefault = false;
let planPrompt = DEFAULT_PLAN_PROMPT;
let rpcClient: RpcClient | null = null;
// Keys the user toggled in this window; server reads no longer overwrite them.
const locallyChanged = new Set<string | null>();
const listeners = new Set<() => void>();

function getPlanState(threadId: string | null): ThreadPlanState {
  if (threadId === null) return { enabled: newThreadEnabled, planned: false };
  return threadStates.get(threadId) ?? { enabled: false, planned: false };
}

function storePlanState(threadId: string | null, enabled: boolean, planned = false) {
  if (threadId === null) {
    newThreadEnabled = enabled;
  } else {
    const previous = threadStates.get(threadId);
    threadStates.set(threadId, { enabled, planned: enabled || planned || previous?.planned === true });
  }
  listeners.forEach((fn) => fn());
}

/** A user change: persisted, and authoritative over later server reads in this window. */
function setPlanMode(threadId: string | null, enabled: boolean) {
  locallyChanged.add(threadId);
  storePlanState(threadId, enabled);
  if (threadId !== null) persistPlanMode(threadId, enabled);
}

function persistPlanMode(threadId: string, enabled: boolean): Promise<void> {
  if (!rpcClient) {
    console.warn("[plan-mode] RPC client not ready; Plan Mode change not persisted", threadId);
    return Promise.resolve();
  }
  return rpcClient
    .call("setPlanMode", { threadId, enabled })
    .then(() => undefined)
    .catch((error: unknown) => {
      console.warn("[plan-mode] failed to persist Plan Mode", threadId, error);
    });
}

function syncPlanState(threadId: string | null, rpc: RpcClient, isCancelled: () => boolean) {
  rpc
    .call("getPlanMode", { threadId })
    .then((res) => {
      planPrompt = res.prompt;
      newThreadDefault = res.defaultOn;
      // Composers remount often (model switch, navigation); a read must never
      // undo a toggle the user made here, even one still being persisted.
      if (isCancelled() || locallyChanged.has(threadId)) return;
      storePlanState(threadId, res.enabled, res.planned);
    })
    .catch((error: unknown) => {
      console.warn("[plan-mode] failed to load Plan Mode", threadId, error);
    });
}

function usePlanMode(threadId: string | null): boolean {
  const [active, setActive] = useState(() => getPlanState(threadId).enabled);

  useEffect(() => {
    const handler = () => setActive(getPlanState(threadId).enabled);
    handler();
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }, [threadId]);

  return active;
}

function hasPromptboxText(promptbox: HTMLElement): boolean {
  const editor = promptbox.querySelector<HTMLElement>('.ProseMirror, [contenteditable="true"], textarea');
  if (!editor) return false;
  if (editor instanceof HTMLTextAreaElement) return editor.value.trim().length > 0;
  return (editor.innerText || "").trim().length > 0;
}

function submitPromptbox(promptbox: HTMLElement) {
  setTimeout(() => {
    const form = (promptbox instanceof HTMLFormElement ? promptbox : promptbox.closest("form")) ??
      promptbox.querySelector("form");
    const submitBtn = form?.querySelector<HTMLButtonElement>(
      'button[type="submit"], button[aria-label*="Submit"], button[title*="Submit"]'
    );
    if (submitBtn && !submitBtn.disabled) {
      submitBtn.click();
    } else if (form) {
      form.requestSubmit();
    }
  }, 20);
}

function sendPlanExitDirectly(threadId: string) {
  // Goes through the fetch hook, which attaches the Plan Mode OFF block.
  fetch(`/api/v1/threads/${encodeURIComponent(threadId)}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: [{ type: "text", text: DEFAULT_IMPLEMENT_PROMPT, mentions: [] }],
      mode: "auto",
    }),
  }).catch((error: unknown) => {
    console.warn("[plan-mode] failed to send implement message", threadId, error);
  });
}

function getSolidBorderColor(box: HTMLElement): string {
  const saved = box.getAttribute("data-original-border-color");
  if (saved && saved !== "transparent" && saved !== "rgba(0, 0, 0, 0)") {
    return saved;
  }

  const computed = window.getComputedStyle(box).borderColor;
  if (computed && computed !== "transparent" && computed !== "rgba(0, 0, 0, 0)") {
    box.setAttribute("data-original-border-color", computed);
    return computed;
  }

  return "var(--border)";
}

function updatePromptboxDashedOverlay(box: HTMLElement, enabled: boolean) {
  let overlay = box.querySelector(`#${OVERLAY_ID}`) as SVGSVGElement | null;
  if (enabled) {
    const borderColor = getSolidBorderColor(box);
    box.style.setProperty("border-color", "transparent", "important");

    if (!overlay) {
      overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      overlay.id = OVERLAY_ID;
      overlay.style.position = "absolute";
      overlay.style.inset = "0";
      overlay.style.width = "100%";
      overlay.style.height = "100%";
      overlay.style.pointerEvents = "none";
      overlay.style.zIndex = "10";
      overlay.style.overflow = "visible";

      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", "0.5");
      rect.setAttribute("y", "0.5");
      rect.setAttribute("width", "calc(100% - 1px)");
      rect.setAttribute("height", "calc(100% - 1px)");
      rect.setAttribute("rx", "11.5");
      rect.setAttribute("ry", "11.5");
      rect.setAttribute("fill", "none");
      rect.setAttribute("stroke-width", "1");
      rect.setAttribute("stroke-dasharray", "14 8");
      rect.setAttribute("stroke-linecap", "round");
      rect.setAttribute("stroke", borderColor);
      rect.style.stroke = borderColor;

      overlay.appendChild(rect);
      box.appendChild(overlay);
    } else {
      const rect = overlay.querySelector("rect");
      if (rect) {
        rect.setAttribute("stroke", borderColor);
        rect.style.stroke = borderColor;
      }
    }
  } else {
    box.style.removeProperty("border-color");
    overlay?.remove();
  }
}

// Keyboard shortcuts act only on the composer the key was pressed in.
interface ComposerShortcuts {
  toggle(): void;
  isActive(): boolean;
  exitAndSend(): void;
}
const composerShortcuts = new Map<Element, ComposerShortcuts>();

function shortcutsFor(target: EventTarget | null): ComposerShortcuts | null {
  let box = target instanceof Element ? target.closest(PROMPTBOX_SELECTOR) : null;
  while (box) {
    const shortcuts = composerShortcuts.get(box);
    if (shortcuts) return shortcuts;
    box = box.parentElement?.closest(PROMPTBOX_SELECTOR) ?? null;
  }
  return null;
}

function PlanModeToggle() {
  const { threadId: rawThreadId } = useBbContext();
  // The new-chat composer has no thread yet.
  const threadId = !rawThreadId || rawThreadId === "new-thread" ? null : rawThreadId;
  const active = usePlanMode(threadId);
  const rpc = useRpc<typeof rpcContract>();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const touchRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const suppressTouchClickRef = useRef(false);

  useEffect(() => {
    rpcClient = rpc;
    let cancelled = false;
    syncPlanState(threadId, rpc, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [threadId, rpc]);

  useEffect(() => {
    const promptbox = buttonRef.current?.closest<HTMLElement>(PROMPTBOX_SELECTOR);
    if (!promptbox) return;
    updatePromptboxDashedOverlay(promptbox, active);
    return () => updatePromptboxDashedOverlay(promptbox, false);
  }, [active]);

  const toggle = useCallback(() => {
    setPlanMode(threadId, !getPlanState(threadId).enabled);
  }, [threadId]);

  useEffect(() => {
    const promptbox = buttonRef.current?.closest<HTMLElement>(PROMPTBOX_SELECTOR);
    if (!promptbox) return;
    composerShortcuts.set(promptbox, {
      toggle,
      isActive: () => getPlanState(threadId).enabled,
      exitAndSend() {
        setPlanMode(threadId, false);
        if (hasPromptboxText(promptbox)) {
          submitPromptbox(promptbox);
        } else if (threadId !== null) {
          sendPlanExitDirectly(threadId);
        }
      },
    });
    return () => {
      composerShortcuts.delete(promptbox);
    };
  }, [threadId, toggle]);

  const label = active
    ? "Plan Mode ON: the agent will only plan. Click or Shift+Tab to turn off; Ctrl/Cmd+Enter turns off and sends."
    : "Plan Mode off. Click or Shift+Tab to turn on.";

  return (
    <button
      ref={buttonRef}
      type="button"
      onPointerDown={(e) => {
        if (!e.isPrimary || e.button !== 0) return;
        suppressTouchClickRef.current = false;
        touchRef.current = e.pointerType === "touch"
          ? { pointerId: e.pointerId, x: e.clientX, y: e.clientY }
          : null;
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        const touch = touchRef.current;
        if (touch && touch.pointerId === e.pointerId &&
          Math.hypot(e.clientX - touch.x, e.clientY - touch.y) > 10) {
          touchRef.current = null;
          suppressTouchClickRef.current = true;
        }
      }}
      onPointerCancel={(e) => {
        if (touchRef.current?.pointerId !== e.pointerId) return;
        touchRef.current = null;
        suppressTouchClickRef.current = true;
      }}
      onPointerUp={(e) => {
        const touch = touchRef.current;
        if (!touch || touch.pointerId !== e.pointerId) return;
        touchRef.current = null;
        suppressTouchClickRef.current = true;
        const bounds = e.currentTarget.getBoundingClientRect();
        if (Math.hypot(e.clientX - touch.x, e.clientY - touch.y) > 10 ||
          e.clientX < bounds.left || e.clientX >= bounds.right ||
          e.clientY < bounds.top || e.clientY >= bounds.bottom) return;
        suppressTouchCompatibilityClick(e.currentTarget.ownerDocument);
        toggle();
      }}
      onMouseDown={(e) => {
        // Match BB's mobile menu triggers: protect against the compatibility
        // mousedown as well as pointerdown dismissing the editor keyboard.
        if (e.button === 0) e.preventDefault();
      }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.button !== 0 || (suppressTouchClickRef.current && e.detail > 0)) return;
        toggle();
      }}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={
        active
          ? "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary/15 px-2 text-xs font-medium text-primary transition-colors hover:bg-primary/25 select-none"
          : "inline-flex size-8 shrink-0 items-center justify-center rounded-lg p-0 text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground select-none"
      }
    >
      <svg
        className="size-4"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
        <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
        {active && <path d="m9 14 2 2 4-4" />}
      </svg>
      {active && <span>Plan</span>}
    </button>
  );
}

// Attach the Plan Mode block to every bb API request that carries a user
// message. Returns null for requests this hook leaves untouched.
function planModeRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): { threadId: string | null; body: Record<string, unknown> } | null {
  if (typeof init?.body !== "string") return null;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : null;
  if (url === null) return null;
  const target = planModeRequestTarget(init.method ?? "GET", new URL(url, window.location.href).pathname);
  if (!target) return null;

  let body: unknown;
  try {
    body = JSON.parse(init.body);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.input) || record.input.length === 0) return null;
  // Forks and child threads are not the new-chat composer's thread.
  if (target.kind === "new-thread" && (record.sourceThreadId || record.parentThreadId)) return null;
  return { threadId: target.kind === "thread" ? target.threadId : null, body: record };
}

async function adoptCreatedThread(response: Response, enabled: boolean) {
  if (!response.ok) return;
  // The next new chat starts from the default again.
  locallyChanged.delete(null);
  storePlanState(null, newThreadDefault);
  if (!enabled) return;
  const created = (await response.clone().json().catch(() => null)) as
    | { id?: unknown; thread?: { id?: unknown } }
    | null;
  const id = created?.id ?? created?.thread?.id;
  if (typeof id !== "string") {
    console.warn("[plan-mode] could not read the created thread id; Plan Mode not carried over");
    return;
  }
  setPlanMode(id, true);
  await persistPlanMode(id, true);
}

function installFetchHook(): () => void {
  const originalFetch = window.fetch;
  const hooked: typeof window.fetch = async (input, init) => {
    const request = planModeRequest(input, init);
    if (!request) return originalFetch(input, init);

    const state = getPlanState(request.threadId);
    const nextInput = withPlanModeMarker(request.body.input as unknown[], markerForState(state), planPrompt);
    const response = await originalFetch(input, {
      ...init,
      body: JSON.stringify({ ...request.body, input: nextInput }),
    });
    if (request.threadId === null) await adoptCreatedThread(response, state.enabled);
    return response;
  };
  window.fetch = hooked;
  return () => {
    if (window.fetch === hooked) window.fetch = originalFetch;
  };
}

export default definePluginApp((app: PluginAppBuilder) => {
  app.composer.customize({
    id: "plan-mode",
    scopes: ["thread", "new-thread"],
    actions: [
      {
        id: "plan-mode-toggle",
        component: PlanModeToggle,
      },
    ],
  });

  app.contentScripts.register({
    id: "plan-mode-keyboard-interceptor",
    mount() {
      function handleWindowKeyDown(e: KeyboardEvent) {
        const shortcuts = shortcutsFor(e.target);
        if (!shortcuts) return;

        // Shift+Tab: toggle Plan Mode
        if (e.key === "Tab" && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          e.stopPropagation();
          shortcuts.toggle();
          return;
        }

        // Cmd/Ctrl+Enter in Plan Mode: turn it off and send (or send "approved" if empty)
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing && shortcuts.isActive()) {
          e.preventDefault();
          e.stopPropagation();
          shortcuts.exitAndSend();
        }
      }

      window.addEventListener("keydown", handleWindowKeyDown, { capture: true });
      const uninstallFetchHook = installFetchHook();

      return () => {
        window.removeEventListener("keydown", handleWindowKeyDown, { capture: true });
        uninstallFetchHook();
      };
    },
  });
});
