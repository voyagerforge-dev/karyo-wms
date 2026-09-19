# Operating an installation

What an operator has to do, and what they are given to do it with, once the four containers are
running.

Derived from `services/karyo-app/src/main/resources/application.yaml`,
`scripts/.env.prod.example`, `infrastructure/docker/nginx/nginx.conf`,
`infrastructure/docker/docker-compose.prod.yml` and `infrastructure/docker/docker-compose.maintenance.yml`.

## Everything runs in one process

There is one application container and one instance of it. Every background job is a Quarkus
scheduler inside it, and the intervals are configuration
(`services/karyo-app/src/main/resources/application.yaml:156-258`). In a build of this repository
these are the scheduled jobs:

| Job | Property | Default interval | Default state |
|---|---|---|---|
| Keycloak login and logout audit poller | `karyo.auth-audit.poll-interval` | 60s | on (`KARYO_AUTH_AUDIT`) |
| Webhook fan-out and delivery | `karyo.webhooks.poll-interval` | 5s | on |
| Replenishment auto-scan | `karyo.replenishment.scan-interval` | 10m | off (`KARYO_REPLENISHMENT_AUTO_SCAN`) |
| DELETABLE stock reaper | `karyo.inventory.purge.interval` | 1h | off (`KARYO_INVENTORY_PURGE`) |

They are `KeycloakEventPoller.kt:52`, `WebhookFanoutScheduler.kt:28` and
`WebhookDeliveryScheduler.kt:30`, `ReplenishmentScheduler.kt:58` and `StockPurgeScheduler.kt:52`,
each with `ConcurrentExecution.SKIP`, so a slow tick is never overlapped by the next one.

"Default state" is the schedule, not the feature: automatic replenishment scanning, for example,
also has to be wanted by a goods owner (see [replenishment](../functional/replenishment.md)).

Five more intervals in the same file belong to commercial engines - monitor evaluation
(`karyo.monitors.interval`, 5m), alert delivery (`karyo.monitors.delivery-interval`, 30s), the
cross-dock expiry sweep (`karyo.crossdock.sweep-interval`, 5m), wave auto-release
(`karyo.wave.auto-interval`, 5m) and order-streaming release (`karyo.streaming.interval`, 5s)
(`application.yaml:170-173,231-244`). Their schedulers live in the engines, so in an image built
from this repository alone they do not exist and those keys are read by nothing. In an image that
carries an engine, the tick runs and the work behind it is gated by the entitlement set; see
[licence and entitlement](licence-and-entitlement.md) and
[gating and degradation](../commercial/gating-and-degradation.md).

Two of the jobs are irreversible or externally visible and are off by default for that reason.
The stock reaper "hard-deletes DELETABLE stock units past their retention window, then the unit
loads they leave empty. Off by default on purpose; only enable once you mean it"
(`scripts/.env.prod.example:109-113`, `application.yaml:212-224`). Its retention window is a
runtime-configuration property, `karyo.inventory.purge.retention-days`, rather than an
environment variable, because retention is a data policy, not an operations preference
(`application.yaml:216-218`) - the reason two knobs that look alike live in different places (see
[the runtime configuration store](../configuration/runtime-configuration-store.md)). Its
`batch-size` caps both candidate queries per call "so one tick is bounded and progress is
monotonic even under a partial failure" (`application.yaml:221-224`).

Three integrations default to inert, each with a non-empty placeholder rather than an empty value,
because SmallRye Config treats an empty resolved value as missing and fails boot:
`karyo.print.url` is `none`, `karyo.ai.provider` is `none`, and the mailer is `mock: true` so that
"no real mail leaves the box until SMTP is explicitly configured" (`application.yaml:135-163`).
`karyo.demo.enabled` is `off` (`application.yaml:245-251`), and the environment template says it
"MUST stay unset/off in real customer deployments" (`scripts/.env.prod.example:99-102`).

## What an operator can see

**Health.** `nginx.conf:132-137` proxies `/q/health` and nothing else from the management
namespace: "the rest of the `/q/` management namespace (metrics, etc.) stays private". The
container health checks use `/q/health/ready` from inside the network
(`docker-compose.prod.yml:88-92`). That route carries no authentication, so a readiness body naming
the deployment's checks is reachable by anyone who can reach the public origin. The comment
explains the scoping - the administration Health page needs it - but not the anonymity; why it is
unauthenticated is not recorded.

**Metrics.** `quarkus-micrometer-registry-prometheus` is on the classpath
(`services/karyo-app/build.gradle.kts:98`) and its endpoint is not routed, so there is no scrape
path from outside the container network, and no collector or dashboard ships
([ADR 0025](../architecture/decisions/0025-metrics-exposed-tracing-off-by-default.md)). A metrics
endpoint existing in the image does not prove that anything monitors the installation.

**Tracing.** `quarkus-opentelemetry` is in the image (`services/karyo-app/build.gradle.kts:99`) and
the `%prod` profile sets `quarkus.otel.sdk.disabled: true` (`application.yaml:333-335`). Nothing
exports spans in production.

**Logs.** In `%prod` the application logs JSON to the console at INFO
(`application.yaml:336-340`), so the container log is the record
([ADR 0026](../architecture/decisions/0026-json-structured-logging.md)). nginx writes an access log
in a custom format that redacts credential-bearing query strings, and the reasoning is precise
enough to be worth carrying: both front ends run the authorisation-code flow with
`responseMode: 'query'`, so every login arrives as `GET /?code=...&state=...`, and nginx's built-in
`combined` format would write that authorisation code into the log, where log shipping, a support
bundle or a screenshot of a tail would re-expose it (`nginx.conf:21-50`).

Only a query that carries a credential is blanked; every other request logs its raw request line,
so a malformed request nginx rejects with 400 still shows what the client actually sent
(`nginx.conf:52-76`). `id_token_hint` is matched with its suffix because keycloak-js puts the full
signed ID token there on RP-initiated logout, and a bare `id_token=` pattern would never fire.
`state` and `session_state` are deliberately **not** triggers and must not be added: `state` is a
live application query filter on delivery orders, advance shipping notices, goods receipts,
transport orders, waves and cross-dock orders, and matching it would blank the query of ordinary
requests and hide exactly what an operator diagnosing one needs.

Nothing ships those logs anywhere, and nothing retains them. Every deploy runs `compose down`
(`deploy-server.sh:736-747`), which removes the containers and their logs with them. An operator
who needs a record of an incident has to capture the logs before the next deploy.

## Rotating credentials

- **The PostgreSQL role password.** PostgreSQL applies `POSTGRES_PASSWORD` only while initialising
  a fresh data directory, so changing the three environment values does not touch the persisted
  role. The deploy script makes that loud rather than silent, and the rotation procedure is in
  [deploying](deploying.md#rotating-the-postgresql-role-password). Its care is worth noting: both
  passwords are read at hidden prompts, the new one is validated against the deploy's own
  credential policy before the role changes, and the `ALTER ROLE` is issued through `psql`'s
  `\getenv`, so neither password appears in process arguments, the SQL program or shell history.
  Keycloak and the application restart **together**.
- **`OIDC_SECRET` and `KEYCLOAK_ADMIN_CLIENT_SECRET`** are rotated through
  [the realm procedure](deploying.md#changing-an-existing-keycloak-realm).
- **The licence** is replaced by changing `KARYO_LICENSE_KEY` and restarting the application; see
  [licence and entitlement](licence-and-entitlement.md).

## Provisioning the first administrator

The production realm import defines no application users (`deploy-server.sh:855`). On a fresh
database Keycloak creates a temporary bootstrap administrator from externally supplied
credentials; the operator uses it at `<origin>/auth/admin/` to create the first Karyo
administrator, then deletes the temporary account and removes `KC_BOOTSTRAP_ADMIN_*` from the
environment file (`deploy-server.sh:856-860`). The steps are in
[deploying](deploying.md#provisioning-the-first-administrator).

On a redeploy against an existing database the script says the opposite, because it checked:
"This redeploy reused the existing database, so Keycloak created no bootstrap administrator"
(`deploy-server.sh:861-864`). That distinction comes from querying Keycloak's own schema for a
`master` realm row, not from a volume name (`deploy-server.sh:203-226`).

## The maintenance window

An ordinary deployment has no path to Keycloak's administration interface at all: the production
Compose file publishes no Keycloak port, and nginx proxies `/auth/` only for the realm endpoints
the front ends need. `docker-compose.maintenance.yml` is the only way to open one; it binds to
`127.0.0.1`, and taking it down again is a mandatory numbered step of both the realm-change and
rollback procedures rather than a clean-up afterthought (`docker-compose.maintenance.yml:1-12`).

The port itself is validated like everything else: `KARYO_KEYCLOAK_MAINTENANCE_PORT` must be an
integer from 1 through 65535 and may be assigned at most once (`deploy-server.sh:393-407`).

## Verifying an installation

Record actual against expected, not just the deploy script's exit status. Every item here names
something an operator would otherwise be tempted to infer:

1. The selected Compose project, the running image IDs and architecture, the application and nginx
   images as a matched pair, readiness, and the first boot logs. The deploy's final 200/401/403
   probes prove routing, not authorised functionality.
2. Desktop and floor sign-in with the intended identities, through the exact public origin and its
   silent single sign-on callbacks rather than a familiar hostname; role and owner refusals; the
   bootstrap and any temporary maintenance access retired.
3. `GET /api/v1/license` reports the expected edition and entitlements for what was installed; any
   extension is discovered **and behaves**; the safety invariants are unchanged. Never paste a
   bearer token into a record.
4. The agreed acceptance run: receipt finish and putaway, the amount, reserved and available
   ledger, pick, pack, manifest and dispatch, held, short and wrong-owner cases, and every required
   interface. On a live installation use approved acceptance records only - never a destructive
   end-to-end suite, the demo reset or the stock reaper.
5. Front-end freshness on desktop and floor, no stale offline queue on a floor device mistaken for
   a server commit, nginx reaching its upstreams, the backup schedule, and observed logging. An
   external printer, carrier or webhook succeeding needs an actual acknowledgement, not a
   downloaded document or an outbox row.

Say plainly whether a fix is proposed, merged, released or installed; none of them implies the
next.

## Related

- [Deploying](deploying.md) - the runbook for everything above that needs a command
- [Upgrade, backup and recovery](upgrade-backup-and-recovery.md) - backing up the two databases
- [Troubleshooting](troubleshooting.md) - failures an installation produces after it is running
- [Runtime and configuration](../architecture/runtime-and-configuration.md) - how configuration
  resolves inside the application
