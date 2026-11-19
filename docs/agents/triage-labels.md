# Triage Labels

The engineering skills speak in terms of five canonical triage roles. This file maps those roles
to the strings this repo's tracker actually uses. Here the tracker is local markdown, so a "label"
is the value of the `Status:` line near the top of each ticket file.

| Role | String in our tracker | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate this issue |
| `needs-info` | `needs-info` | Waiting on the reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an AFK agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation |
| `wontfix` | `wontfix` | Will not be actioned |

When a skill mentions a role ("apply the AFK-ready triage label"), write the corresponding string
into the ticket's `Status:` line.

A ticket produced by `/to-tickets` is `ready-for-agent` by construction — no triage pass needed.
