# Clawforum

**Describe what you want. A team of AI agents figures out the rest.**

![node >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![license MIT](https://img.shields.io/badge/license-MIT-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)

**Motion** coordinates. **Claws** execute. Every step is verified before it moves forward, the full execution trail visible throughout. You just talk to Motion. The rest happens on its own.

<!-- demo: clawforum start → Motion chat → task completion -->

---

## Table of Contents

- [Features](#features)
- [How It Works](#how-it-works)
- [Highlights](#highlights)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [LLM Providers](#llm-providers)
- [Commands](#commands)
- [Configuration](#configuration)
- [Contributing](#contributing)
- [Acknowledgements](#acknowledgements)
- [License](#license)

---

## Features

- **Contracts with automatic acceptance** — every subtask has explicit pass/fail criteria (script or LLM). Claws redo failing work before it counts as done.
- **Motion + parallel Claws** — a dedicated coordinator breaks your goals into contracts and dispatches them to independent worker agents running in parallel.
- **Transparent by design** — always know what each agent is working on right now, what it has done, and what it was assigned. Not just a final result handed to you after the fact.
- **Local-first** — connect Ollama to run entirely offline with no API key. Works with any major LLM provider out of the box.
- **Night dreams** — agents periodically reflect on past work sessions and archived contracts, extracting insights that carry forward into future tasks — getting more contextually aware over time.

---

## How It Works

```
You
 └─→ Motion  (coordinator)
      ├─ breaks goals into contracts
      └─→ Claw  (worker)
           ├─ works autonomously on its assignment
           └─ done → verified before moving on
```

Multiple Claws can run in parallel — Motion coordinates them all.

- Motion and each Claw run as separate daemon processes
- A Watchdog monitors all processes and auto-restarts crashes
- Agent communication is file-based — no network, no hidden state
- Sessions and contracts persist across restarts

---

## Highlights

**Contracts with automatic acceptance**

Most agent frameworks just run and hope. Clawforum doesn't count a subtask as done until it passes acceptance criteria — a shell script, a file check, or an LLM review. Failed checks notify the Claw to redo the work before moving on.

**Motion + parallel Claws**

Motion is a coordinator, not a worker. It breaks your goal into contracts and dispatches them to Claws that run in parallel and independently. You never need to manage Claws directly — tell Motion what you want and it handles the rest.

**Transparent by design**

Every assignment, every message, every decision lives in plain files on your machine. You can open any agent's inbox and see exactly what it was told to do, or check its work log to see what it did and why. Agent frameworks that hide execution state make it impossible to trust or verify results — Clawforum doesn't. As a bonus, messages survive crashes and restarts automatically.

**Local-first, provider-agnostic**

Connect Ollama and run with no API key, no network, no data leaving your machine. Or use Anthropic, OpenAI, DeepSeek, Gemini, and more — swap providers in one line of config.

**Night dreams**

Agents periodically reflect on past work sessions and archived contracts, extracting insights that carry forward into future tasks. The system gets more contextually aware over time — without interrupting anything in progress.

---

## Installation

```bash
git clone https://github.com/leefir/clawforum
cd clawforum
pnpm install && pnpm build
npm link
```

**Requires**: Node.js ≥ 22, [pnpm](docs/install-pnpm.md)

---

## Quick Start

```bash
clawforum start
```

That's it. If this is your first run, it walks you through selecting an LLM provider and setting your API key, then opens the Motion chat. Then talk to Motion freely. The more you interact, the better it understands you. The more your Claws work, the more they learn.

Describe what you want:

```
> Set up a Next.js project with TypeScript and Tailwind, add a landing page,
  and write tests for the main components.
```

Check in any time:

```bash
clawforum status        # see all running agents
clawforum motion chat   # resume the Motion chat
```

---

## LLM Providers

Clawforum works with any major LLM provider — Anthropic, OpenAI, DeepSeek, Gemini, Ollama, and more. Select your provider interactively with `clawforum init`; if the corresponding API key environment variable is already set, it's detected automatically.

```yaml
# ~/.clawforum/config.yaml
llm:
  primary:
    preset: anthropic
    api_key: ${ANTHROPIC_API_KEY}
    model: claude-3-7-sonnet-20250219
```

---

## Commands

**Everyday**

```bash
clawforum start          # init + launch Motion + open chat
clawforum motion chat    # reopen Motion chat
clawforum status         # see all running agents
clawforum stop           # gracefully stop everything
```

**Advanced**

```bash
clawforum claw list                # list all Claws and their status
clawforum claw chat <name>         # talk to a specific Claw directly
clawforum claw trace [--claw <n>]  # inspect contract execution step by step
```

---

## Configuration

Configuration lives in `~/.clawforum/config.yaml` and is created by `clawforum init`.
See [docs/configuration.md](docs/configuration.md) for the full reference.

---

## Contributing

```bash
pnpm test:run    # run all tests
pnpm typecheck   # TypeScript strict check
```

---

## Acknowledgements

Inspired by [openclaw](https://github.com/openclaw/openclaw).

---

## License

MIT
