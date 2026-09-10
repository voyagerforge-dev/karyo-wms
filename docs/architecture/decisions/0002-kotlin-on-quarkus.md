# ADR 0002: The backend is Kotlin on Quarkus

**Status:** Accepted

## Context

The backend carries dense business rules - stock selection, location finding, order and pick
state machines, replenishment - where a null reference or an unhandled case can send stock to the
wrong place. It is written against the Jakarta programming model that the rest of the architecture
relies on: CDI beans and SPIs injected across modules ([ADR 0006](0006-api-and-core-modules.md)),
CDI events with transaction phases ([ADR 0008](0008-synchronous-rest-and-cdi-events.md)), JAX-RS
resources, JPA entities and JTA transactions.

It runs self-hosted, one host per company, beside PostgreSQL, Keycloak and nginx, with a default
memory limit of 1.5 GB for the application container
(`infrastructure/docker/docker-compose.prod.yml:87`). It needs OIDC, health checks, metrics,
scheduling, fault tolerance, schema migration, a workable local-development loop and an LLM
integration, without bespoke glue for each.

## Decision

- The backend is **Kotlin** on a **Java 21** toolchain, running on **Quarkus**. Both versions are
  pinned in the version catalog (`gradle/libs.versions.toml:2-3`) and applied through the build
  conventions ([ADR 0003](0003-gradle-kotlin-dsl-and-version-catalog.md)).
- All main source is Kotlin. There is no Java source under any `src/main`.
- The Quarkus platform BOM is applied as an enforced platform
  (`services/karyo-app/build.gradle.kts:80`), and the backend uses Quarkus extensions for REST,
  Hibernate ORM with Panache for Kotlin, PostgreSQL, Flyway, caching, fault tolerance, health,
  Micrometer, OpenTelemetry, JSON logging, OIDC, validation, scheduling and LangChain4j
  (`gradle/libs.versions.toml:15-47`).
- The Kotlin `allopen` and `jpa` compiler plugins apply everywhere: `allopen` opens classes that
  carry the annotations Quarkus proxies, `jpa` generates the no-argument constructors Hibernate
  needs, and Java nullability annotations are read strictly
  (`buildSrc/src/main/kotlin/karyo.kotlin-conventions.gradle.kts:1-26`).
- JPA entities are ordinary mutable classes (`OutboxEvent.kt:8-10`); DTOs and event payloads are
  data classes (`WavePickActivityEvent.kt:9-13`).
- The application runs on the JVM as a Quarkus fast-jar (`.github/workflows/ci.yml:172-173`).
  Native compilation is not used.

## Consequences

- Nullability is checked by the compiler. Sealed result types and data classes keep the domain
  types short and exhaustively handled.
- Every Java library in the stack - Hibernate, Jackson, LangChain4j - is used directly from Kotlin.
- Quarkus resolves CDI at build time, so an unsatisfied injection point fails the build rather than
  a request.
- Quarkus Dev Services start PostgreSQL for tests and for local work, and Keycloak for tests,
  with nothing installed on the machine ([ADR 0028](0028-quarkus-dev-services.md)).
- The `allopen` annotation list is maintained by hand. A class whose only proxy-relevant annotation
  is missing from it stays final and cannot be proxied.
- JPA entities cannot be data classes, and their properties stay mutable.
- Quarkus releases often, so the platform needs regular upgrades. Because its BOM is an enforced
  platform, a plain dependency constraint cannot raise a version the BOM manages; security floors
  for those coordinates go through the root build's `securityFloor` instead
  (`build.gradle.kts:109-121`).

## Alternatives considered

- **Spring Boot.** Rejected for a larger memory footprint and slower startup than Quarkus in JVM
  mode, and for having no equivalent of Dev Services.
- **Micronaut.** Rejected: no Dev Services equivalent and a smaller extension ecosystem, which
  would have meant more custom integration work.
- **Helidon.** Rejected: the smallest community of the candidates and no dedicated Kotlin support.
- **Java alone.** Rejected: no compile-time null safety, which matters most in a system where a null
  location or lot can misroute stock, and noticeably more code for the same domain model - records
  have no copy, no defaults and no mutable fields.
- **Scala.** Rejected: a steeper learning curve and a much smaller hiring pool for a domain that is
  mostly imperative state machines, and little Quarkus support.

## Evidence

- `gradle/libs.versions.toml:2-3` - the Kotlin and Quarkus versions
- `gradle/libs.versions.toml:15-47` - the platform BOM and the extensions in use
- `buildSrc/src/main/kotlin/karyo.kotlin-conventions.gradle.kts:1-26` - Kotlin plugins, toolchain,
  `allopen` list, strict nullability
- `buildSrc/src/main/kotlin/karyo.quarkus-service.gradle.kts:1-5` - the Quarkus plugin on every module
- `services/karyo-app/build.gradle.kts:80` - the BOM as an enforced platform
- `build.gradle.kts:109-121` - why version floors bypass plain constraints
- `.github/workflows/ci.yml:172-173` - the fast-jar build

## Related

- [ADR 0003](0003-gradle-kotlin-dsl-and-version-catalog.md) - where the versions and conventions live
- [ADR 0008](0008-synchronous-rest-and-cdi-events.md) - the CDI event model this depends on
- [ADR 0028](0028-quarkus-dev-services.md) - the local-development loop Quarkus provides
