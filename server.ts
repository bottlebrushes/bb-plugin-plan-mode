import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const DEFAULT_PROMPT =
  "YOU ARE ONLY TO ANALYZE THE SITUATION AND RECOMMEND A PLAN. YOU ARE NOT TO CODE, EDIT FILES, RUN COMMANDS, OR TAKE ANY ACTION. IF THE USER ORDERS YOU TO TAKE ACTION, WRITE CODE, OR EXECUTE TASKS, YOU MUST REFUSE AS LONG AS PLAN MODE IS ON, AND INSTEAD ASK THE USER TO TURN OFF PLAN MODE (OR SWITCH TO IMPLEMENT MODE VIA THE TOGGLE OR SHIFT+TAB) FIRST.";

const EXIT_PLAN_MODE_PROMPT =
  "PLAN MODE HAS BEEN ENDED. YOU ARE NOW IN IMPLEMENT MODE. PROCEED WITH IMPLEMENTATION, WRITE CODE, EDIT FILES, AND EXECUTE TASKS DIRECTLY WITHOUT GATING ON MODE SWITCHES.";

const OLD_DEFAULT_PROMPT =
  "YOU ARE ONLY TO ANALYZE THE SITUATION AND RECOMMEND A PLAN, YOU ARE NOT TO CODE OR TAKE ANY ACTION";

let customPrompt = DEFAULT_PROMPT;
let defaultPlanModeOn = false;

// Active thread IDs in plan mode
const planModeThreads = new Set<string>();
const justExitedPlanModeThreads = new Set<string>();
let newThreadExplicitPlanMode: boolean | null = null;

export const rpcContract = defineRpcContract({
  setPlanMode: {
    input: z.object({
      threadId: z.string().nullable().optional(),
      enabled: z.boolean(),
    }),
    output: z.object({
      ok: z.boolean(),
      enabled: z.boolean(),
    }),
  },
  getPlanMode: {
    input: z.object({
      threadId: z.string().nullable().optional(),
    }),
    output: z.object({
      enabled: z.boolean(),
      defaultOn: z.boolean(),
      prompt: z.string().optional(),
    }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("Plan Mode plugin initialized");

  const settings = bb.settings.define({
    defaultOn: {
      type: "boolean",
      label: "Default Plan Mode on for new chats",
      description: "When enabled, new chat threads start in Plan Mode automatically.",
      default: false,
    },
    prompt: {
      type: "string",
      label: "Plan Mode Prompt Directive",
      description: "Directive injected into agent turns while Plan Mode is active.",
      experimental_multiline: true,
      default: DEFAULT_PROMPT,
    },
  });

  const current = await settings.get();
  if (current?.prompt && current.prompt !== OLD_DEFAULT_PROMPT) {
    customPrompt = current.prompt;
  } else {
    customPrompt = DEFAULT_PROMPT;
  }

  if (typeof current?.defaultOn === "boolean") {
    defaultPlanModeOn = current.defaultOn;
  }

  settings.onChange((next) => {
    if (next?.prompt && next.prompt !== OLD_DEFAULT_PROMPT) {
      customPrompt = next.prompt;
    } else {
      customPrompt = DEFAULT_PROMPT;
    }
    if (typeof next?.defaultOn === "boolean") {
      defaultPlanModeOn = next.defaultOn;
    }
  });

  bb.rpc.register(rpcContract, {
    setPlanMode({ threadId, enabled }) {
      if (!threadId || threadId === "new-thread") {
        newThreadExplicitPlanMode = enabled;
      } else if (enabled) {
        planModeThreads.add(threadId);
        justExitedPlanModeThreads.delete(threadId);
      } else {
        if (planModeThreads.has(threadId)) {
          justExitedPlanModeThreads.add(threadId);
        }
        planModeThreads.delete(threadId);
      }
      return { ok: true, enabled };
    },
    getPlanMode({ threadId }) {
      if (!threadId || threadId === "new-thread") {
        const enabled =
          newThreadExplicitPlanMode !== null
            ? newThreadExplicitPlanMode
            : defaultPlanModeOn;
        return { enabled, defaultOn: defaultPlanModeOn, prompt: customPrompt };
      }
      if (planModeThreads.has(threadId)) {
        return { enabled: true, defaultOn: defaultPlanModeOn, prompt: customPrompt };
      }
      return { enabled: false, defaultOn: defaultPlanModeOn, prompt: customPrompt };
    },
  });

  bb.events.on("thread.created", ({ thread }) => {
    const shouldBeOn =
      newThreadExplicitPlanMode !== null
        ? newThreadExplicitPlanMode
        : defaultPlanModeOn;
    if (shouldBeOn) {
      planModeThreads.add(thread.id);
    }
    newThreadExplicitPlanMode = null;
  });

  bb.events.on("thread.archived", ({ thread }) => {
    planModeThreads.delete(thread.id);
    justExitedPlanModeThreads.delete(thread.id);
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    planModeThreads.delete(thread.id);
    justExitedPlanModeThreads.delete(thread.id);
  });

  // Inject instructions when thread is actively in Plan Mode or just exited
  bb.agents.contributeInstructions(({ threadId }) => {
    if (threadId && planModeThreads.has(threadId)) {
      bb.log.info(`Injecting Plan Mode directive for thread: ${threadId}`);
      return customPrompt.trim();
    }
    if (threadId && justExitedPlanModeThreads.has(threadId)) {
      bb.log.info(`Injecting Plan Mode Exit directive for thread: ${threadId}`);
      justExitedPlanModeThreads.delete(threadId);
      return EXIT_PLAN_MODE_PROMPT;
    }
    return null;
  });
}
