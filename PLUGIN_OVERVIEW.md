## What you get

Plan Mode gives any agent in bb a dedicated planning and exploration phase before it writes code, edits files, or runs commands. It keeps tasks safe by ensuring complex architectural decisions and refactoring strategies are reviewed before implementation begins.

## How it works

When Plan Mode is active, an instructional directive is injected into the agent's turn instructions:

- The agent is instructed to explore the repository, inspect dependencies, and propose a detailed step-by-step roadmap.
- If an instruction or prompt orders execution or file modification, the agent explicitly refuses to proceed until Plan Mode is switched off.
- The prompt injection occurs silently at the backend level through agent contribution hooks. The directive never clutters your composer input or chat timeline.
- The composer window displays a distinct dashed border around the card, giving an immediate visual indicator that Plan Mode is running.

## Controls and shortcuts

- **Composer Switcher**: Click the mode button beside the microphone to toggle between **Implement** (`</>`) and **Plan** (clipboard icon).
- **Shift + Tab**: Toggles instantly between Implement and Plan Mode without leaving the composer.
- **Cmd + Enter**: Exits Plan Mode back to Implement Mode.

## Settings

Customize Plan Mode behavior in bb Settings or via the CLI:

- **Default Plan Mode on for new chats** (`defaultOn`): Start every new conversation in Plan Mode automatically.
- **Plan Mode Prompt Directive** (`prompt`): Tailor the exact prompt directive injected into the model for your team or workflow.
