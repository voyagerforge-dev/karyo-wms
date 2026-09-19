# ADR 0025: Metrics are exposed and no collector ships; tracing is present and off

**Status:** Accepted

## Context

An operator running Karyo needs to know whether it is up, whether it is healthy, and - when
something has gone wrong - what it was doing. The deployment is four containers on one host
(ADR 0022), run by whoever installed it.

Quarkus supplies health checks, Prometheus-format metrics and OpenTelemetry tracing as
extensions, and including them costs little. Collecting, storing and showing what they produce is
a different matter: it takes a scraper, storage and a dashboard, which are services somebody has
to run. And a request in Karyo is served by one process in one transaction (ADR 0001), so there is
no path across services for a trace to reveal.

## Decision

- **Health.** SmallRye Health serves `/q/health`. nginx proxies that one path from the management
  namespace and keeps the rest of it private. The containers' healthchecks read
  `/q/health/ready` from inside the network.
- **Metrics.** Micrometer's Prometheus registry is in the application, and Quarkus exposes
  Prometheus-format metrics on the management path, `/q/metrics`. Only the built-in meters are in
  use; Karyo defines no business metrics of its own. nginx does not proxy the metrics path, so it
  is reachable only from the Compose network.
- **No collector ships.** The deployment contains no metrics server, no dashboard, no alerting and
  no log or trace backend. An operator who wants them runs them.
- **Tracing is present and off.** The OpenTelemetry extension is in the application, with an OTLP
  exporter endpoint configured (`OTEL_ENDPOINT`, `http://localhost:4317` unless set), and it is
  switched off in every profile Karyo runs in: `quarkus.otel.enabled: false` in dev,
  `quarkus.otel.sdk.disabled: true` in prod, and `quarkus.otel.enabled=false` in tests. No spans
  are produced.

## Consequences

- An installation reports its health with no extra service, and the console's health page reads
  the same endpoint.
- **Nothing scrapes the metrics.** They exist in every image and go unread unless an operator puts
  a scraper on the Compose network.
- **Known defect: the readiness endpoint carries no authentication on the public origin.** Anyone
  who can reach the origin can read the readiness body. The nginx configuration explains why only
  `/q/health` is proxied, not why it is anonymous.
- **There are no traces, so there is no trace id.** `ProblemDetail` carries a `traceId` field that
  nothing populates.
- **Known defect: correlation stops at the log.** The `X-Correlation-Id` header reaches the logging
  context (ADR 0026) and nothing else. A journal row's `correlationId` is written by the operation
  that creates the row, not taken from the header, so querying journals by the header's value finds
  nothing.
- Whether a collector should ship with the deployment has not been decided. None does.

## Alternatives considered

- **A metrics server, dashboards and alerting deployed with every installation.** Not part of the
  deployment. They would add at least three services to a four-container stack on one host. No
  decision against them is recorded; they are simply not part of it.
- **A hosted monitoring or tracing service.** Rejected: an installation runs on a host its operator
  controls, often on premises, and the product does not assume it may send data to a third party or
  tie its operators to one vendor's pricing.
- **Tracing switched on.** Rejected while every request is one process and one transaction: a trace
  would show a call path inside a single JVM that the logs already show.
- **Metrics exposed through nginx.** Rejected: the management namespace stays private, and only
  health is proxied.

## Evidence

- `services/karyo-app/build.gradle.kts:96-100` - the health, Prometheus, OpenTelemetry and JSON
  logging extensions
- `services/karyo-app/src/main/resources/application.yaml:146-154` - the health path and the OTLP
  exporter endpoint
- `karyo-app/.../application.yaml:312-313,333-335` - tracing off in dev and prod
- `services/karyo-app/src/test/resources/application.properties:14-15` - tracing off in tests
- `infrastructure/docker/nginx/nginx.conf:132-137` - only `/q/health` is proxied
- `infrastructure/docker/docker-compose.prod.yml:88-92` - the application's healthcheck
- `libs/karyo-common/src/main/kotlin/com/karyo/common/exception/ProblemDetail.kt:16` - the unused
  `traceId`
- `libs/karyo-security/src/main/kotlin/com/karyo/security/TenantFilter.kt:48-51` - where the
  correlation id goes
- [Operating an installation](../../operations/operating-an-installation.md)
- [API error contract](../../integration/api-error-contract.md)

## Related

- [ADR 0001](0001-modular-monolith.md) - one process, one transaction per request
- [ADR 0022](0022-compose-four-container-deployment.md) - the deployment that ships no collector
- [ADR 0026](0026-json-structured-logging.md) - the log, which is the record that remains
- [ADR 0017](0017-versioned-rest-api-and-error-contract.md) - the error contract `ProblemDetail`
  belongs to
