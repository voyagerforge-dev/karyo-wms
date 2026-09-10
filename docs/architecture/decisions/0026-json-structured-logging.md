# ADR 0026: Logs are structured JSON on standard output

**Status:** Accepted

## Context

Karyo's application log has two readers. A developer reads it in a terminal while working. An
operator, or a tool the operator runs, reads it from the container after something has gone wrong
in production. The second reader needs every line to be machine-parseable, with the request's
identity attached, and neither reader wants the application managing files, rotation or shipping.

## Decision

- **The application writes its log to standard output** and never manages log files.
- **In the prod profile the console log is JSON** (`quarkus-logging-json`), at INFO. In dev and
  test it stays plain text, for reading in a terminal.
- **Every authenticated request carries three values in the logging context**, set by
  `TenantFilter`: `tenantId` (the goods owner id, ADR 0014), `userId`, and `correlationId` - the
  `X-Correlation-Id` request header, or empty when the header is absent. Karyo does not generate a
  correlation id.
- **nginx writes its own access log** in a custom format that blanks the query string, and the
  referrer, of any request carrying a credential. Both front ends receive their sign-in
  authorization code in the query string, and the stock format would write that code into the log.
- **No log aggregation ships.** The container runtime holds the log.

## Consequences

- Any tool that reads JSON lines parses the production log without patterns, and every line of a
  request says who made it and for which goods owner.
- **Nothing survives a redeploy.** The deploy script removes the containers before starting new
  ones (ADR 0022), and the log goes with them. With no aggregation, the after-the-fact record of an
  incident is whatever was copied out before the next deploy.
- **Known defect: the correlation id stops at the log.** It is in the logging context and nowhere
  else; it does not reach journal rows (ADR 0025).
- **Whether the logging context can leak between requests is not established.** `TenantFilter` sets
  the three values and nothing removes them, and an anonymous request returns before setting them.
  If the context is held per thread rather than per request in this configuration, an anonymous
  request served on a thread that last served an authenticated one would log the earlier user's
  values. It has not been measured.
- The application log has no redaction filter. Keeping secrets and tokens out of it is a matter of
  review, not of the pipeline.

## Alternatives considered

- **A log aggregation stack - a shipper, a store and a query interface - deployed with Karyo.** Not
  part of the deployment. Nothing records a decision against it; it has not been built.
- **Plain-text logs in production.** Rejected: a plain line needs a pattern to parse, and
  multi-line messages break line-based tooling.
- **JSON in development and tests too.** Rejected: JSON is hard to read in a terminal, so the dev and
  test profiles keep plain text.
- **Log files written by the application.** Rejected: rotation, retention and shipping belong to
  whatever runs the container, not to the application.

## Evidence

- `services/karyo-app/build.gradle.kts:100` - the JSON logging extension
- `services/karyo-app/src/main/resources/application.yaml:5-9` - plain text by default
- `karyo-app/.../application.yaml:336-340` - JSON at INFO in prod
- `libs/karyo-security/src/main/kotlin/com/karyo/security/TenantFilter.kt:48-51` - the three
  logging-context values
- `infrastructure/docker/nginx/nginx.conf:21-31,71-76` - why the access log redacts, and the format
  that does it
- `scripts/deploy-server.sh:736-747` - the containers, and their logs, are removed on every deploy
- [Operating an installation](../../operations/operating-an-installation.md)

## Related

- [ADR 0025](0025-metrics-exposed-tracing-off-by-default.md) - the other signals, and why the log
  is the one that carries a request's identity
- [ADR 0022](0022-compose-four-container-deployment.md) - the deployment the log lives and dies in
- [ADR 0014](0014-silo-tenancy-and-goods-owners.md) - what `tenantId` means
