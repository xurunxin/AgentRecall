# `skills/`

Reusable agent skills for working in this repository.

A skill is a markdown document with YAML frontmatter (`name`,
`description`) that an AI agent can load on demand. The
`description` is the **only** field that decides whether the skill
fires — it carries the trigger phrases. Body content is loaded only
after the skill is selected, so the description must be rich enough
to match every real invocation while staying focused.

Layout conventions:

- One folder per skill, named after the skill: `skills/<name>/`.
- The entry document is `SKILL.md` inside that folder.
- Optional `scripts/` for executable helpers (use only when the
  skill genuinely needs to run code; pure guidance belongs in
  `SKILL.md`).
- Optional `references/` for larger companion documents the skill
  can link to.

Current skills:

| Skill | Purpose |
| --- | --- |
| `agent-recall-cli` | Operate the AgentRecall CLI (`agent-recall` binary): health checks, memory inspection, export/import, backup/restore, schema migration, admin capability. |

Adding a new skill:

1. Create `skills/<name>/SKILL.md` with frontmatter (`name`,
   `description`).
2. Update this README's "Current skills" table.
3. Reference it from `AGENTS.md` only if every contributor must
   know — otherwise let the trigger description handle discovery.