> "I could be bounded in a nutshell, and count myself a king of infinite space."
> — Hamlet

# chestnut

![node >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![license MIT](https://img.shields.io/badge/license-MIT-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)

*A single AI agent — small enough to keep its full attention on what you want.*

**Your intent is the most valuable thing. chestnut honors it above all.**

## How your intent reaches the work

The whole of chestnut is built to protect your intent — from your words to what actually gets done. Your assistant doesn't do work itself; it dispatches.

When you ask for something real, your assistant summons a claw for the job. A contract is drafted from your full conversation, specifying the deliverables and how each will be verified — by a script or LLM check that decides if a subtask actually passed. The claw handles it from there.

You don't need to write careful prompts. Because the conversation has been holding nothing but your intent, your assistant has the full picture — even a short, casual request becomes a complete contract.

The contract might unfold into hours of work, but your chat stays at the level of intent.

## How the work holds up

From dispatch through completion, five mechanisms keep the work focused, accurate, and improving:

| Mechanism | What it does |
|---|---|
| **Skill-matched dispatch** | When a contract is created, the system picks relevant skills from a pool and installs them to the claw. Each claw gets exactly the capabilities its task needs. |
| **Dedicated context window** | Each project runs in its own claw with its own context window. No competing concerns — the claw keeps all of its attention on the one job. |
| **Verification gates** | A subtask passes only when its verification check passes — a script or LLM judgment specified in the contract. The claw can't just say "done". |
| **Mid-execution drift correction** | A separate check periodically compares the claw's activity against the contract's overall expectations and steers it back if it drifts. |
| **Retrospective learning** | Each completed contract distills lessons into a shared skill pool. Future tasks of similar shape benefit automatically. The longer you use chestnut, the more capable it becomes. |

## Features

**Conversation stays open.** Hand off a task — the work runs in a claw while your assistant stays available. Switch topics, ask new questions, or check on progress whenever.

**Transparent and inspectable.** Every message, every contract, every decision is a plain file on disk — no hidden database, no opaque service. Browse a claw's inbox directly, or use `chestnut claw <name> trace --contract <id>` for the full execution trail, `claw <name> steps` for turn-by-turn reasoning, `claw <name> chat` to talk to it directly.

**Talk, don't look things up.** Tell your assistant what you want done — start a claw, check status, trace a claw — and it invokes the right chestnut CLI command for you. For multi-step setup or configuration, chestnut comes with pre-built contracts (coming): pick one and your assistant handles the work end-to-end.

**Versioned workspaces.** Each claw's workspace is a git repo with automatic commits. Any point in the work is recoverable.

**Local-first, provider-agnostic.** Connect Ollama and run with no API key, no network, no data leaving your machine. Or use Anthropic, OpenAI, DeepSeek, Gemini, and more — swap providers in one line of config.

**Context-preserving clones.** To keep your assistant's (and each claw's) working context holding only what matters, sub-work that would crowd it is handled by a temporary clone with the same context. The clone has the full picture and brings back only the meaningful result — cache hits keep it cheap.

---

<!--
Sections below are still the old Chestnut draft. We'll rewrite them in
the next iterations (Install, LLM providers, Commands, Configuration,
Contributing, Acknowledgements, License).
-->

## Installation

```bash
git clone https://github.com/nutshell-dev/chestnut
cd chestnut
pnpm install && pnpm build
npm link
```

**Requires**: Node.js ≥ 22, [pnpm](docs/install-pnpm.md)

---

## Quick Start

```bash
chestnut start
```

That's it. If this is your first run, it walks you through selecting an LLM provider and setting your API key, then opens the Motion chat. Then talk to Motion freely. The more you interact, the better it understands you. The more your Claws work, the more they learn.

Describe what you want:

```
> Set up a Next.js project with TypeScript and Tailwind, add a landing page,
  and write tests for the main components.
```

Check in any time:

```bash
chestnut status        # see all running agents
chestnut motion chat   # resume the Motion chat
```

---

## LLM Providers

Chestnut works with any major LLM provider — Anthropic, OpenAI, DeepSeek, Gemini, Ollama, and more. Select your provider interactively with `chestnut init`; if the corresponding API key environment variable is already set, it's detected automatically.

```yaml
# ./.chestnut/config.yaml
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
chestnut start          # init + launch Motion + open chat
chestnut motion chat    # reopen Motion chat
chestnut status         # see all running agents
chestnut stop           # gracefully stop everything
```

**Advanced**

```bash
chestnut claw list                       # list all Claws and their status
chestnut claw <name> chat                # talk to a specific Claw directly
chestnut claw <name> trace --contract <id>  # inspect contract execution step by step
```

For the full command set (`claw <name> {create,send,outbox,import,read,health,step,status,...}`, `motion daemon / steps`, `contract create / log / events`, `skill *`, etc.), run `chestnut --help` or `chestnut claw --help`.

---

## Configuration

Configuration lives in `./.chestnut/config.yaml` (per workspace, relative to the directory where you run `chestnut`) and is created by `chestnut init`. The yaml block above shows the basic shape; additional providers follow the same `llm.primary.*` pattern.

**Workspace root override**: set `CHESTNUT_ROOT=/some/path` to force config and runtime state to live under that path instead of the current directory. Useful if you want a stable per-user workspace independent of `cwd`.

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
