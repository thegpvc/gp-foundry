# gp-foundry — agent bootstrap

<!-- Contributing to gp-foundry itself? This file is the CONSUMER bootstrap (setting up a
     pipeline in another repo). For hacking on gp-foundry, see README.md → Development. -->

> **You are a coding agent.** A human pointed you here to set up an autonomous delivery
> pipeline ("dark factory") in the repository you're working in: issues in → triaged,
> planned, implemented, reviewed, auto-merged PRs out — self-healing and self-improving.
> Follow this file top to bottom. Requires Node >= 20 and a git repo; the `gh` CLI
> (authenticated) makes setup fully automatic but is optional until push time.

Everything runs through `npx` — **no global install needed**.

## If you are Claude Code: install the skill and use it instead

```bash
npx -y @thegpvc/gp-foundry@latest skill
```

Then follow `.claude/skills/gp-foundry/SKILL.md` — it is the richer, Socratic version of
this file (a five-question interview that designs the pipeline with the user). Everything
below is the condensed flow for agents without skill support.

## 1. Scaffold

```bash
npx -y @thegpvc/gp-foundry@latest init
```

This writes `.github/harness.dot` (the pipeline as a DOT graph — the single source of
truth), `.github/agents/` (config, scope, merge policy, communication guide, and a role
file per agent: scout/planner/builder/reviewer/fixer/janitor/supervisor/retro), and
`.github/agent-setup/action.yml`.

## 2. Adapt to this repo (ask the user; don't guess silently)

Confirm with the user, then edit:

- **`.github/agent-setup/action.yml`** — add the project's toolchain (setup-python,
  setup-go, pnpm, …) below the agent-CLI step, so pipeline agents can build and test.
- **`.github/agents/scope.yaml`** — what must agents NEVER touch (`immutable_paths`)?
  Add the repo's build/test commands to `guidance:` (e.g. "run `make test` before any PR").
- **`.github/agents/roles/*.md`** — the "Repo-specific guidance" of `builder.md`,
  `reviewer.md`, `fixer.md`: test commands, conventions, gotchas. Role edits need no rebuild.
- Optional topology changes (add/remove lanes) go in `.github/harness.dot` — never edit
  `.github/workflows/*.yml` by hand; they are generated.

## 3. Bring the factory up

```bash
npx -y @thegpvc/gp-foundry@latest up
```

Creates the labels (`build`/`plan`/`needs-human`/`needs-rebase`), vendors the runtime
actions into `.github/actions/`, compiles the workflows, and runs `doctor`. It exits
non-zero with specific ✗ items until the factory is ready — fix what it names and re-run.
(Offline/no-remote? It skips the GitHub steps cleanly; re-run after `gh repo create`.)

## 4. Hand two secrets to the human (you cannot do this part)

Tell the user to run:

```bash
gh secret set CLAUDE_CODE_OAUTH_TOKEN   # the coding agent's auth token
gh secret set AGENT_PAT                 # fine-grained PAT: Contents + Pull requests + Issues + Actions, RW, this repo
```

(`AGENT_PAT` exists because the built-in `GITHUB_TOKEN` cannot trigger downstream
workflows — the pipeline would silently stall between stages.)

## 5. Ship it

```bash
git add .github && git commit -m "add agent harness (gp-foundry)" && git push
npx -y @thegpvc/gp-foundry@latest doctor   # everything green?
```

Then have the user **file an issue** describing a small change. The 🕵️ scout triages it
within a minute and the factory takes it from there. Day-2: `npx -y @thegpvc/gp-foundry@latest status`
shows work in flight and anything stalled; add `gp-foundry build --check` to CI as a
drift gate.

## Rules you must respect afterwards

1. `.github/workflows/*.yml` are **generated** — change `.github/harness.dot` and re-run
   `npx -y @thegpvc/gp-foundry@latest build`, never hand-edit.
2. Role/policy/scope files are runtime content — edit freely, no rebuild needed.
3. Every retry loop in the graph must keep a bounded escape edge (the default graph's
   `fixer -> needs_human [when="attempts>=3"]`).
