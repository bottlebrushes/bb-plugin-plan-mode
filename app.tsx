import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  definePluginApp,
  useBbContext,
  useRpc,
  type PluginAppBuilder,
  type PluginRpcClient,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";

const OVERLAY_ID = "plan-mode-border-overlay";
const DEFAULT_IMPLEMENT_PROMPT = "approved";

// Thread-specific state and global fallback
const threadPlanModeState = new Map<string, boolean>();
let currentGlobalPlanMode = false;
let currentActiveThreadId: string | null = null;
let globalRpcClient: PluginRpcClient<typeof rpcContract> | null = null;
const listeners = new Set<() => void>();

function notifyListeners() {
  listeners.forEach((fn) => fn());
}

export function getThreadPlanMode(threadId: string | null): boolean {
  if (!threadId) return currentGlobalPlanMode;
  return threadPlanModeState.get(threadId) ?? false;
}

export function setThreadPlanMode(threadId: string | null, enabled: boolean) {
  if (!threadId) {
    currentGlobalPlanMode = enabled;
  } else {
    threadPlanModeState.set(threadId, enabled);
  }

  notifyListeners();
  applyDashedBorderToAllPromptboxes(enabled);
}

export function toggleCurrentPlanMode(): boolean {
  const current = getThreadPlanMode(currentActiveThreadId);
  const next = !current;
  setThreadPlanMode(currentActiveThreadId, next);
  if (globalRpcClient) {
    globalRpcClient
      .call("setPlanMode", { threadId: currentActiveThreadId, enabled: next })
      .catch(() => {});
  }
  return next;
}

export function hasPromptboxText(promptbox?: HTMLElement | null): boolean {
  if (typeof document === "undefined") return false;
  const box =
    promptbox ||
    document.querySelector<HTMLElement>(
      'form[data-promptbox], [data-promptbox], [data-promptbox-shell] form'
    );
  if (!box) return false;

  const editor = box.querySelector<HTMLElement>(
    '.ProseMirror, [contenteditable="true"], textarea'
  );
  if (!editor) return false;

  if (editor instanceof HTMLTextAreaElement) {
    return editor.value.trim().length > 0;
  }
  return (editor.innerText || "").trim().length > 0;
}

export function submitPromptbox(promptbox?: HTMLElement | null) {
  if (typeof document === "undefined") return;
  const box =
    promptbox ||
    document.querySelector<HTMLElement>(
      'form[data-promptbox], [data-promptbox], [data-promptbox-shell] form'
    );
  if (!box) return;

  setTimeout(() => {
    const form = (box instanceof HTMLFormElement ? box : box.closest("form")) as HTMLFormElement | null;
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

export function sendPlanExitDirectly(threadId: string | null) {
  if (typeof window === "undefined" || !threadId || threadId === "new-thread") return;
  fetch(`/api/v1/threads/${encodeURIComponent(threadId)}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: [{ type: "text", text: DEFAULT_IMPLEMENT_PROMPT, mentions: [] }],
      mode: "auto",
    }),
  }).catch(() => {});
}

function getSolidBorderColor(box: HTMLElement): string {
  // If previously saved:
  const saved = box.getAttribute("data-original-border-color");
  if (saved && saved !== "transparent" && saved !== "rgba(0, 0, 0, 0)") {
    return saved;
  }

  // Read current computed border color before setting it transparent
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
    if (overlay) {
      overlay.remove();
    }
  }
}

function applyDashedBorderToAllPromptboxes(enabled: boolean) {
  if (typeof document === "undefined") return;
  const promptboxes = document.querySelectorAll<HTMLElement>(
    'form[data-promptbox], [data-promptbox], [data-promptbox-shell] form'
  );
  promptboxes.forEach((box) => {
    updatePromptboxDashedOverlay(box, enabled);
  });

  if (enabled) {
    document.body.classList.add("bb-plan-mode-active");
    document.documentElement.classList.add("bb-plan-mode-active");
  } else {
    document.body.classList.remove("bb-plan-mode-active");
    document.documentElement.classList.remove("bb-plan-mode-active");
  }
}

function usePlanMode(threadId: string | null): [boolean, (next: boolean) => void] {
  const [active, setActive] = useState(() => getThreadPlanMode(threadId));

  useEffect(() => {
    setActive(getThreadPlanMode(threadId));
    const handler = () => {
      setActive(getThreadPlanMode(threadId));
    };
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }, [threadId]);

  const updateMode = useCallback(
    (next: boolean) => {
      setThreadPlanMode(threadId, next);
    },
    [threadId]
  );

  return [active, updateMode];
}

function PlanModeToggle() {
  const { threadId } = useBbContext();
  const [active, setActiveState] = usePlanMode(threadId);
  const rpc = useRpc<typeof rpcContract>();
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    currentActiveThreadId = threadId;
    globalRpcClient = rpc;
  }, [threadId, rpc]);

  // Sync state from backend RPC
  useEffect(() => {
    let cancelled = false;
    rpc
      .call("getPlanMode", { threadId })
      .then((res) => {
        if (!cancelled && res) {
          if (typeof res.enabled === "boolean") {
            setActiveState(res.enabled);
          }
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [threadId, rpc, setActiveState]);

  // Apply dashed border overlay to the promptbox
  useEffect(() => {
    const promptbox = buttonRef.current?.closest(
      'form[data-promptbox], [data-promptbox], [data-promptbox-shell]'
    ) as HTMLElement | null;

    if (promptbox) {
      updatePromptboxDashedOverlay(promptbox, active);
    }

    applyDashedBorderToAllPromptboxes(active);
    return () => {
      if (promptbox) {
        updatePromptboxDashedOverlay(promptbox, false);
      }
    };
  }, [active]);

  const toggle = useCallback(() => {
    const next = !active;
    setActiveState(next);
    rpc.call("setPlanMode", { threadId, enabled: next }).catch(() => {});
  }, [active, setActiveState, rpc, threadId]);

  // Attach Shift+Tab and Cmd+Enter / Ctrl+Enter directly on the promptbox form
  useEffect(() => {
    const promptbox = buttonRef.current?.closest(
      'form[data-promptbox], [data-promptbox]'
    ) as HTMLElement | null;
    if (!promptbox) return;

    function handleFormKeyDown(e: KeyboardEvent) {
      // Shift + Tab: toggle between Implement and Plan
      if (e.key === "Tab" && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        toggle();
        return;
      }

      // Cmd + Enter or Ctrl + Enter: when in plan mode, leaves plan mode and submits (or sends "approved" if empty)
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing) {
        if (active) {
          e.preventDefault();
          e.stopPropagation();

          setActiveState(false);
          rpc.call("setPlanMode", { threadId, enabled: false }).catch(() => {});

          if (hasPromptboxText(promptbox)) {
            submitPromptbox(promptbox);
          } else {
            sendPlanExitDirectly(threadId);
          }
        }
      }
    }

    promptbox.addEventListener("keydown", handleFormKeyDown, { capture: true });
    return () => {
      promptbox.removeEventListener("keydown", handleFormKeyDown, { capture: true });
    };
  }, [active, toggle, setActiveState, rpc, threadId]);

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      }}
      aria-label={
        active
          ? "Plan mode active (Shift+Tab to switch to Implement)"
          : "Implement mode active (Shift+Tab to switch to Plan)"
      }
      title={
        active
          ? "Plan mode active (Shift+Tab or Ctrl+Enter to exit and implement)"
          : "Implement mode (Shift+Tab to switch to Plan)"
      }
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg p-0 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground select-none"
    >
      {active ? (
        /* Plan Icon: Clipboard with checkmark */
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
          <path d="m9 14 2 2 4-4" />
        </svg>
      ) : (
        /* Implement Icon: Code brackets </> */
        <svg
          className="size-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      )}
    </button>
  );
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
    mount({ signal }) {
      function handleWindowKeyDown(e: KeyboardEvent) {
        // Shift + Tab: toggle between Implement and Plan
        if (e.key === "Tab" && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          e.stopPropagation();
          toggleCurrentPlanMode();
          return;
        }

        // Cmd + Enter or Ctrl + Enter: leaves plan mode and submits (or sends "approved" if empty)
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing) {
          const isPlanOn = getThreadPlanMode(currentActiveThreadId);
          if (isPlanOn) {
            e.preventDefault();
            e.stopPropagation();
            setThreadPlanMode(currentActiveThreadId, false);
            if (globalRpcClient) {
              globalRpcClient
                .call("setPlanMode", { threadId: currentActiveThreadId, enabled: false })
                .catch(() => {});
            }
            if (hasPromptboxText()) {
              submitPromptbox();
            } else {
              sendPlanExitDirectly(currentActiveThreadId);
            }
          }
        }
      }

      window.addEventListener("keydown", handleWindowKeyDown, { capture: true });

      const observer = new MutationObserver(() => {
        if (document.body.classList.contains("bb-plan-mode-active")) {
          applyDashedBorderToAllPromptboxes(true);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      return () => {
        window.removeEventListener("keydown", handleWindowKeyDown, { capture: true });
        observer.disconnect();
        applyDashedBorderToAllPromptboxes(false);
      };
    },
  });
});
