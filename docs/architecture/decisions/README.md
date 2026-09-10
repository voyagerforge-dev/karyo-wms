# Decision records

The architecture decisions Karyo embodies today. Each record states a decision the code implements
now, why it was taken, what it costs, and what was considered instead. Where the reason for
something is not recorded anywhere, the record says so rather than guessing. Every record cites the
files that embody it, so a reader can check it against the code instead of trusting it.

## The records

| Record | Decision | Area |
|---|---|---|
| [0001](0001-modular-monolith.md) | Karyo is one deployable modular monolith | Structure |
| [0002](0002-kotlin-on-quarkus.md) | The backend is Kotlin on Quarkus | Structure |
| [0003](0003-gradle-kotlin-dsl-and-version-catalog.md) | The build is Gradle with the Kotlin DSL, a version catalog and convention plugins | Structure |
| [0004](0004-one-postgresql-database-and-schema.md) | One PostgreSQL database and one `karyo` schema serve every module | Persistence |
| [0005](0005-flyway-migrations-at-boot.md) | Flyway migrates the schema at boot, in per-module version bands, out of order | Persistence |
| [0006](0006-api-and-core-modules.md) | `-api` modules hold contracts, `-core` modules hold implementations, and no core depends on another | Structure |
| [0007](0007-cross-module-references-by-id.md) | Modules refer to each other's rows by id, never by foreign key | Persistence |
| [0008](0008-synchronous-rest-and-cdi-events.md) | Synchronous REST at the edge, synchronous CDI events inside, each observer in a chosen transaction phase | Integration |
| [0009](0009-transactional-outbox.md) | State changes leave the process through a transactional outbox | Integration |
| [0010](0010-crud-with-an-inventory-journal.md) | Stock is stored as current state with an immutable journal, not event-sourced | Persistence |
| [0011](0011-reporting-reads-the-database-directly.md) | Reporting reads the operational database directly | Persistence |
| [0012](0012-caffeine-for-reference-data-only.md) | An in-process Caffeine cache holds reference data only; stock is never cached | Persistence |
| [0013](0013-keycloak-oidc.md) | Keycloak is the mandatory OpenID Connect provider | Identity |
| [0014](0014-silo-tenancy-and-goods-owners.md) | One installation per operating company; `client_id` is a goods owner, not a permission | Identity |
| [0015](0015-principal-kind-independent-of-roles.md) | `principal_kind` decides owner scope independently of roles, and its absence means OWNER | Identity |
| [0016](0016-two-frontends-same-origin.md) | Two front ends, served from the API's own origin: the console at `/`, the floor PWA at `/m/` | Front end |
| [0017](0017-versioned-rest-api-and-error-contract.md) | The external API is versioned REST under `/api/v1`, with an RFC 7807 error body | Integration |
| [0018](0018-strategy-driven-configuration.md) | Tunable behaviour is strategy-driven, through a family of patterns rather than one rule | Configuration |
| [0019](0019-extensions-compile-into-the-build.md) | Extensions are compiled into the build; nothing is uploaded into a running image | Extension |
| [0020](0020-free-and-commercial-boundary-per-module.md) | The free and commercial boundary is drawn per Gradle module | Commercial boundary |
| [0021](0021-signed-entitlement-resolved-at-startup.md) | Entitlement is an Ed25519-signed token, resolved once at startup | Commercial boundary |
| [0022](0022-compose-four-container-deployment.md) | Compose with four containers is the supported deployment | Delivery |
| [0023](0023-reproducible-container-images.md) | Container images are built reproducibly | Delivery |
| [0024](0024-conventional-commits-and-semver.md) | Commits follow Conventional Commits, and releases follow Semantic Versioning | Delivery |
| [0025](0025-metrics-exposed-tracing-off-by-default.md) | Metrics are exposed and no collector ships; tracing is present and off | Observability |
| [0026](0026-json-structured-logging.md) | Logs are structured JSON on standard output | Observability |
| [0027](0027-ai-copilot-over-tool-calls.md) | An optional AI copilot works through tool calls, not retrieval | AI |
| [0028](0028-quarkus-dev-services.md) | Quarkus Dev Services supply local and test infrastructure | Development |

## How a record is written

Every record has the same six sections, so the set reads as one collection:

1. **Context** - the forces: what problem the decision answers and which constraints bind it.
2. **Decision** - what Karyo does, as a rule a reader can check against the code.
3. **Consequences** - the benefits, the costs, and any known defect that sits on the decision,
   stated as current behaviour.
4. **Alternatives considered** - each option not taken and why. Where the reason is not recorded,
   the record says "not recorded".
5. **Evidence** - the files that embody the decision, cited as `path:line`.
6. **Related** - the records and documents a reader needs next.

The title line is `# ADR NNNN: <the decision as a short sentence>`, and the status is always
**Accepted**, because this directory holds current decisions only.

## How the set is kept true

- **A record describes what the code does now.** When a change contradicts a record, the record is
  rewritten in the same pull request as the code. The reasoning that led away from the old decision
  belongs in the new record's Alternatives considered, if it still explains anything.
- **A decision that no longer holds is deleted, not kept with a changed status.** Git history keeps it. A
  deleted record's number is not reused; a new decision takes the next number.
- **Never invent a reason.** A rationale written down becomes indistinguishable from a real one. If
  nothing records why something is the way it is, say so.
- **A record whose evidence has moved is wrong.** Re-check the citations when the files they point
  at change, and fix the record rather than the reader's expectations.

[Maintaining this repository](../../guides/maintaining-this-repository.md) covers the same rules for
every other document.
