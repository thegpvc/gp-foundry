# pr-scope

The guard a PR lane runs first. It answers, for one pull request:

- **in scope?** — does the pipeline look at this PR at all (the rollout dial);
- **agent-written?** — may a lane that *writes* act on it.

Both come from `src/shared/scope.ts`, the same implementation the merge gate
uses, so a lane and the gate cannot disagree about a PR.

## Scope, in order

1. A draft is never in scope.
2. A PR carrying the rollout's skip label is never in scope.
3. A PR opened by `bot-login` is always in scope.
4. A PR opened by a login in the rollout's `botAuthors` is in scope (`bot-author`).
   A guard (one PR, from its event) does not run the lane on it — the bot's own
   events carry no secrets — but hands it to the lane's scheduled bot pass.
   Listing keeps it only while every commit on it is authored by the bot and
   committed and signed by GitHub (web-flow, verified), fewer than 250 of them,
   ending at the listed head. A listed PR carries the update's semver level as
   `bump` when one can be told.
5. Another bot's PR is out, unless that bot is named in the rollout's `authors`.
6. With no rollout — or one naming neither authors nor an opt-in label — every
   remaining PR is in scope.
7. Otherwise: a listed author, or the opt-in label.

## Agent-written

Opened by `bot-login`, and every commit on the head attributed to it. One commit
by anyone else, or one GitHub cannot attribute to an account, makes the PR
human-written. Asked only with `require-agent-written: true` (lanes that push or
merge).

## Failing closed

A PR that cannot be read gives `run: false` with a warning, not a red job. A
malformed `rollout` input fails the step.

## Inputs / outputs

See `action.yml`. `run` is the one output a workflow needs: `true` when the lane
should run.
