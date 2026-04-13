# Phase 4 Trial And Feedback Playbook

## Goal

Turn 3 to 10 real trial users into durable product signals for onboarding, activation, reuse, and retention.

Phase 4 is not just "did they try Vega once". The target is to learn:

- who reaches first value fastest
- which onboarding surfaces create the least friction
- which memories users actually reuse in later sessions
- which blockers prevent a second or third session

## Trial User Profiles

| Segment | Best fit | Qualifying signal | What success looks like |
| --- | --- | --- | --- |
| Solo multi-agent builder | One developer using Cursor, Codex, or Claude Code across the same repo | Uses at least 2 agent surfaces weekly | Reuses decisions/pitfalls across sessions without re-explaining context |
| Long-lived project owner | Maintains one repo or product area for multiple weeks | Has recurring tasks, bug classes, or onboarding context worth remembering | Reports faster follow-up sessions and fewer repeated explanations |
| Self-hosted team or platform lead | Owns an internal coding workflow or shared AI tooling lane | Wants one memory backend behind MCP, CLI, and HTTP | Validates shared setup, remote access, and team reuse patterns |

## Inclusion Criteria

- Uses coding agents for real implementation work at least 3 times per week
- Has a repository or project area that stays active for more than one session
- Can tolerate a self-hosted or local-first developer tool
- Is willing to provide setup friction notes and one short weekly feedback checkpoint

## Exclusion Criteria

- Only wants a human-first note app or personal wiki
- Has no recurring repo context to preserve between sessions
- Cannot run local CLI commands or a small local service
- Is evaluating Vega only as a generic knowledge base rather than as coding-agent memory infrastructure

## Trial Flow

| Step | Target artifact | Exit signal |
| --- | --- | --- |
| Intake | User segment, current agent stack, current pain point | We know which workflow Vega should improve |
| Setup | `vega health`, `vega setup --show`, relevant setup helper | User can complete the initial setup without hidden blockers |
| First value | `store -> recall -> session-start` loop in one repo | User confirms the first recalled memory is useful |
| Week-one reuse | Second and third coding sessions | User reuses prior decisions, pitfalls, or preferences instead of restating them |
| Weekly review | Scorecard + interview notes | We can classify the account as continue, at risk, or drop |

## Weekly Scorecard

| Metric | Definition | Green | Yellow | Red |
| --- | --- | --- | --- | --- |
| Setup completion | User finishes the intended setup flow | Same day | Within 3 days | Still blocked after 3 days |
| Time to first useful recall | First session where recall/session-start returns something the user values | First session | Second session | No useful recall yet |
| Reuse signal | User explicitly references prior stored memory in a later session | 2+ times/week | 1 time/week | 0 times/week |
| Surface coverage | Number of agent surfaces successfully connected | 2+ | 1 | 0 |
| Retention intent | User says they plan to keep Vega in the workflow next week | Clear yes | Unsure | No |
| Blocking issues | Count of unresolved blockers that stop progress | 0 | 1 | 2+ |

## Weekly Cadence

| Day | Action | Output |
| --- | --- | --- |
| Day 0 | Intake and qualification | Segment, repo, target workflow, expected value |
| Day 1 | Observe setup and first memory loop | Setup notes, blocker log, first-value timestamp |
| Day 3 | Check second-session reuse | Evidence of recall/session-start reuse or failure mode |
| Day 5 | Collect blocker updates | Prioritized list of onboarding and reliability issues |
| Day 7 | Run weekly review | Scorecard, quotes, keep/pause/drop recommendation |

## Operator Checklist

- Record which setup path the user followed: `--codex`, `--claude`, `--cursor`, or manual MCP
- Capture the first failing command or missing file exactly
- Ask whether `vega doctor` or `vega setup --show` changed the troubleshooting outcome
- Note the first memory that the user says was genuinely useful later
- Classify every blocker as onboarding, retrieval quality, product positioning, or workflow mismatch

## Intake Form

- User name or handle
- Team or company
- Primary repository or project
- Primary agent surfaces in use
- Why Vega is being tried now
- What repeated context or memory failure hurts the most today
- Desired outcome after one week

## Weekly Interview Script

1. What task did you use Vega on this week?
2. Which agent surface did you use first?
3. Where did setup slow down or become confusing?
4. Did `vega setup --show` or `vega doctor` help you recover faster?
5. What was the first memory that saved you time later?
6. What still feels like extra ceremony rather than real value?
7. Would you keep Vega in the workflow next week? Why or why not?
8. What is the single biggest missing piece for your workflow right now?

## Review Output Template

Use this shape each week:

```text
User:
Segment:
Repo:
Primary surface:
Setup status:
First useful recall:
Reuse count this week:
Top blocker:
Retention intent:
Recommended next action:
```

## Decision Rules

- Continue when setup is complete and the user reports at least one useful reuse signal
- At risk when setup is complete but no later-session reuse appears
- Pause when the user is fundamentally looking for a note app or generic wiki instead of coding-agent memory
- Drop when onboarding is blocked for more than one week without a credible recovery path
