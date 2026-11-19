# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the
codebase. This repo is **single-context**.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root.
- **`docs/adr/`**: read the ADRs that touch the area you are about to work in.

If either doesn't exist, **proceed silently**. Don't flag the absence and don't suggest creating
them upfront — `/domain-modeling` (reached via `/grill-with-docs`) creates them lazily when a term
or a decision actually gets resolved.

## File structure

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-….md
│   └── 0002-….md
└── src…
```

## Use the glossary's vocabulary

When your output names a domain concept — an issue title, a ticket, a test name, a refactor
proposal — use the term as defined in `GLOSSARY.md`. Don't drift to the synonyms it lists under
`_Avoid_`.

If the concept you need isn't in the glossary, that is a signal: either you are inventing language
the project doesn't use (reconsider), or there is a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly instead of silently overriding it:
"Contradicts ADR-0001 (锚点写在 HTML 里), but worth reopening because…"
