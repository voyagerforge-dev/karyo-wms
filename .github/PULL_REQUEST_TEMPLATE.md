<!--
Base this on main. CONTRIBUTING.md owns the full route; this template is what a reviewer needs.
Delete a section only if it genuinely does not apply, and say so rather than deleting it silently.
-->

## The problem

<!-- The operator's or the maintainer's problem in their terms, not the patch in yours. Link the
     issue. For a defect: expected result, actual result, version, screen or request, role and
     owner scope, configuration. Redact identities and secrets. -->

## What this change does

<!-- Scope, and the owning module. Link the decision record or document that governs it. If this
     changes a decision, the record is rewritten in this pull request. -->

## Boundaries touched

<!-- Tick what this change crosses and say how each is handled. An unticked list is fine; a wrong
     tick is expensive. -->

- [ ] Module or API contract (cross-module call, SPI, event payload, wire compatibility)
- [ ] Database migration (forward only; applied migrations are immutable, comments included)
- [ ] Identity, roles or owner scope (`principal_kind`, `client_id`, `TenantContext`)
- [ ] The free/commercial boundary (an `-api` seam a commercial engine implements, the licence gate)
- [ ] CI, build or dependency versions
- [ ] Frontend behaviour or UI (desktop `/`, floor app `/m/`)
- [ ] None of the above

## Verification

<!-- Exact commands and their actual results. Executed, failed AND skipped counts, not exit
     status: one failed Quarkus boot can skip most of the backend suite. Do not list a check you
     did not run. -->

```
```

## What this does not prove

<!-- The honest half: checks not run, mocked-only coverage, no browser end-to-end run, no image
     build, unrelated defects seen and left alone. "Nothing" is an acceptable answer only if it
     is true. -->

## Migration, upgrade and operational impact

<!-- New migration versions and their directories; whether an existing installation needs
     anything; configuration or environment changes; rollback limits. "None" is fine. -->

---

- [ ] The documents this change affects are updated, including every document the linked issue
      names as needing an update (or this pull request says why one does not)
- [ ] Conventional Commit subject; `git diff --check` clean; no secrets in the diff
