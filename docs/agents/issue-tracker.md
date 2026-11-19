# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at
  `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined file
- Triage state is a `Status:` line near the top of each issue file (see `triage-labels.md`)
- Comments append to the bottom of the file under a `## Comments` heading
- `.scratch/` is gitignored: these are working notes, not repo history

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number.

## Relationship to `.ai/planning/`

`.ai/planning/PLAN.md` holds dated decisions (D-numbers) and `.ai/planning/task.md` holds
requirements (R-numbers) and the older step-by-step plans. Those remain the long-term record;
`.scratch/` holds the per-feature spec and tickets one implementation session works from.
Link between them instead of duplicating.
