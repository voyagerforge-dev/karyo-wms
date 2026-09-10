# Karyo WMS agent guide

Guidance for agents working in this repository. It points at the authoritative sources rather than
restating them; where this file and a source disagree, the source wins.

- **Documentation map:** [docs/README.md](docs/README.md) lists every document. It is the answer to
  "why is it like this": the [decision records](docs/architecture/decisions/README.md) give each
  decision's reason, and say plainly where no reason is recorded.
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md) is the change route - branch model, commits,
  checks, pull requests. The invariants a change must not break are in the
  [architecture guide](docs/guides/architecture-guide.md).

## Build and test

A real JDK 21 with `javac` is required; a Java runtime alone fails while Gradle resolves `buildSrc`.

```bash
./gradlew :services:karyo-app:quarkusBuild        # the one deployable
QUARKUS_HTTP_TEST_PORT=0 ./gradlew test          # backend tests; Dev Services need a container runtime
./gradlew detekt
```

Read executed, failed and skipped counts, not the exit status. The full set of checks, the front
ends included, is in [CONTRIBUTING.md](CONTRIBUTING.md#checks-before-you-open-a-pull-request); a
running local session is in [developer onboarding](docs/guides/developer-onboarding.md#boot-a-local-session).

## Module boundary

- An `-api` module holds DTOs, SPI interfaces and the event payloads other modules observe - never
  entities, services or REST resources.
- A `-core` module holds JPA entities, repositories, services and REST resources, and never depends
  on another module's `-core`. The three recorded waivers are not precedent.
- [ADR 0006](docs/architecture/decisions/0006-api-and-core-modules.md) owns the rule, and
  [ADR 0007](docs/architecture/decisions/0007-cross-module-references-by-id.md) its data half: other
  modules' rows are referenced by id, never by foreign key.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
