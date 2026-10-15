// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { rpcContract } from "./server";

afterEach(() => {
  // Release any short-lived compatibility-click guard before the next test.
  fireEvent.pointerDown(document.body);
  cleanup();
});

async function mountToggle(enabled = true) {
  const app = await loadPluginApp(() => import("./app"));
  const Toggle = app.composerCustomizations[0]!.actions![0]!.component;
  const threadId = `mobile-toggle-${crypto.randomUUID()}`;
  const slot = renderSlot<object, typeof rpcContract>({
    component: () => <form data-promptbox=""><textarea aria-label="Composer" /><Toggle /></form>,
  }, {}, {
    context: { projectId: "project", threadId },
    rpc: {
      getPlanMode: () => ({ enabled, planned: enabled, defaultOn: false, prompt: "Plan only" }),
      setPlanMode: ({ enabled }: { enabled: boolean }) => ({ ok: true, enabled }),
    },
  });
  const button = slot.getByRole("button");
  const editor = slot.getByRole("textbox");
  Object.defineProperty(button, "getBoundingClientRect", {
    value: () => new DOMRect(0, 0, 80, 32),
  });
  await waitFor(() => expect(button.getAttribute("aria-pressed")).toBe(String(enabled)));
  const writes = () => slot.inspection.rpcCalls.filter(({ method }) => method === "setPlanMode");
  return { slot, button, editor, threadId, writes };
}

function pointer(target: HTMLElement, type: string, init: {
  pointerType?: string; pointerId?: number; isPrimary?: boolean;
  button?: number; clientX?: number; clientY?: number;
} = {}) {
  const { pointerType = "touch", pointerId = 1, isPrimary = true, ...mouse } = init;
  const event = new MouseEvent(type, {
    bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: 16, ...mouse,
  });
  Object.defineProperties(event, {
    pointerType: { value: pointerType }, pointerId: { value: pointerId }, isPrimary: { value: isPrimary },
  });
  return fireEvent(target, event);
}

describe("Plan Mode activation", () => {
  it("turns off on touch release without a click, even if the editor has blurred", async () => {
    const { slot, button, editor, threadId, writes } = await mountToggle();
    editor.focus();
    pointer(button, "pointerdown");
    // Keyboard dismissal may happen despite pointerdown.preventDefault on iOS.
    editor.blur();
    expect(writes()).toEqual([]);
    pointer(button, "pointerup");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    slot.lifecycle.unmount();
    expect(writes()).toEqual([{ method: "setPlanMode", input: { threadId, enabled: false } }]);
  });

  it("prevents the compatibility mousedown from taking editor focus", async () => {
    const { button, editor } = await mountToggle();
    editor.focus();
    pointer(button, "pointerdown");
    pointer(button, "pointerup");
    const allowsFocusChange = fireEvent.mouseDown(button, { button: 0 });
    if (allowsFocusChange) editor.blur();
    expect(allowsFocusChange).toBe(false);
    expect(document.activeElement).toBe(editor);
  });

  it("ignores the late touch click without blocking a new tap or keyboard click", async () => {
    const { button, writes } = await mountToggle();
    pointer(button, "pointerdown");
    pointer(button, "pointerup");
    fireEvent.click(button, { detail: 1 });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(writes()).toHaveLength(1);
    pointer(button, "pointerdown");
    pointer(button, "pointerup");
    fireEvent.click(button, { detail: 1 });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(writes()).toHaveLength(2);
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.click(button, { detail: 0 });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(writes()).toHaveLength(3);
  });

  it("blocks a retargeted compatibility click after the action unmounts", async () => {
    const { slot, button, writes } = await mountToggle();
    pointer(button, "pointerdown");
    pointer(button, "pointerup");
    slot.lifecycle.unmount();
    expect(fireEvent.click(document.body, { detail: 1 })).toBe(false);
    expect(writes()).toHaveLength(1);
    pointer(document.body, "pointerdown");
    expect(fireEvent.click(document.body, { detail: 1 })).toBe(true);
  });

  for (const gesture of ["cancel", "move", "outside"] as const) {
    it(`does not toggle after a ${gesture} gesture, including a late click`, async () => {
      const { button, writes } = await mountToggle();
      pointer(button, "pointerdown");
      if (gesture === "cancel") pointer(button, "pointercancel");
      if (gesture === "move") pointer(button, "pointermove", { clientX: 35 });
      pointer(button, "pointerup", gesture === "outside" ? { clientX: 81 } : {});
      fireEvent.click(button, { detail: 1 });
      expect(button.getAttribute("aria-pressed")).toBe("true");
      expect(writes()).toEqual([]);
    });
  }

  it("ignores a secondary touch without cancelling the primary tap", async () => {
    const { button, writes } = await mountToggle();
    pointer(button, "pointerdown");
    pointer(button, "pointerdown", { pointerId: 2, isPrimary: false });
    pointer(button, "pointerup", { pointerId: 2, isPrimary: false });
    expect(writes()).toEqual([]);
    pointer(button, "pointerup");
    expect(writes()).toHaveLength(1);
  });

  for (const pointerType of ["mouse", "pen"]) {
    it(`keeps ${pointerType} activation on click`, async () => {
      const { button, editor, writes } = await mountToggle();
      editor.focus();
      pointer(button, "pointerdown", { pointerType });
      pointer(button, "pointerup", { pointerType });
      expect(writes()).toEqual([]);
      fireEvent.mouseDown(button, { button: 0 });
      fireEvent.mouseUp(button, { button: 0 });
      fireEvent.click(button, { detail: 1 });
      expect(button.getAttribute("aria-pressed")).toBe("false");
      expect(document.activeElement).toBe(editor);
      expect(writes()).toHaveLength(1);
      expect(pointer(button, "pointerdown", { pointerType, button: 2 })).toBe(true);
    });
  }

  it("supports keyboard and assistive-technology clicks in both directions", async () => {
    const { button } = await mountToggle(false);
    button.focus();
    fireEvent.click(button, { detail: 0 });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(button);
    fireEvent.click(button, { detail: 0 });
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });
});
