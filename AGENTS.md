# WowIdle（工作名）

魔兽风格公会会长放置模拟游戏，面向 Steam 与 TapTap。项目语言与领域术语见 `GLOSSARY.md`，架构决策见 `docs/adr/`。

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (sumo91/RaidNight) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
