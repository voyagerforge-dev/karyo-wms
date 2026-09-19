# Runtime and configuration

What runs, how requests reach it, where its configuration comes from, and what runs on a timer.

Derived from `infrastructure/docker/docker-compose.prod.yml`,
`infrastructure/docker/nginx/nginx.conf`, `services/karyo-app/src/main/resources/application.yaml`
and every `@Scheduled` site.

## Four containers

| Container | Image |
|---|---|
| `postgresql` | `docker.io/postgres:16-alpine` |
| `keycloak` | `quay.io/keycloak/keycloak:26.0` |
| `karyo-app` | `${KARYO_APP_IMAGE:-karyo/karyo-app:latest}` |
| `nginx` | `${KARYO_NGINX_IMAGE:-karyo/nginx:latest}` |

One volume (`karyo-pgdata`), one network (`karyo-net`)
(`infrastructure/docker/docker-compose.prod.yml:126-131`). Only nginx publishes ports (`:109`).
Compose with these four containers is the supported deployment
([ADR 0022](decisions/0022-compose-four-container-deployment.md)); how to install one is
[Deploying](../operations/deploying.md).

## nginx routing

| Location | Target |
|---|---|
| `/api/internal/` | `return 404` |
| `/api/` | `karyo-app` |
| `/q/health` | `karyo-app` |
| `/auth/`, `/resources/`, `/realms/` | Keycloak |
| `/m/` | floor PWA, SPA fallback to the mobile `index.html` |
| `/` | desktop console, SPA fallback to the desktop `index.html` |

The `/api/internal/` block is defence in depth (`infrastructure/docker/nginx/nginx.conf:115-125`).
Cross-module calls are in-process SPI bean injection, not REST, and the application exposes no
internal REST resources, but without the block the prefix would be reachable from the internet
through the `/api/` rule. A more specific prefix wins in nginx regardless of ordering.

`/q/health` is proxied deliberately narrowly (`:132-136`). The rest of the `/q/` management
namespace, metrics included, stays private.

Two operational properties are worth keeping in view because neither is visible from the compose
file: nginx re-resolves its upstream addresses at runtime -- the `karyo-app` and `keycloak` servers
are marked `resolve` (`nginx.conf:101-108`) -- so recreating an upstream container is picked up on
its own within about ten seconds and needs no coordinated nginx refresh, and rootless Podman cannot
normally bind port 80.

## One configuration file

`application.yaml` in the aggregator is the only main-source runtime configuration in the
repository. There is no per-module config file. It carries the Flyway locations list, the OIDC and
Keycloak admin client settings, the union of every module's Caffeine cache names, the langchain4j
model definitions, every scheduler interval, and the configuration keys of the commercial engines,
which are inert in a free installation
([The commercial boundary](commercial-boundary.md#what-stays-public)).

Runtime properties additionally resolve through a database chain: client row, then SYS row, then
config, then catalogue default. A database row can therefore intentionally override an environment
variable, which is the opposite of the usual precedence and worth knowing before debugging a
setting that will not take. `SystemPropertyCatalog`
(`services/auth-service/karyo-auth-core/src/main/kotlin/com/karyo/auth/config/SystemPropertyCatalog.kt`)
is the register of knobs; [the runtime configuration store](../configuration/runtime-configuration-store.md)
describes the chain in full.

## AI provider configuration

`KARYO_AI_PROVIDER` accepts `anthropic`, `ollama` or `none`, and **defaults to `none`**
(`application.yaml:158-159`). Two named langchain4j models are defined at build time (`:105-124`):
`claude` bound to provider `anthropic`, and `local` bound to provider `ollama`.

The copilot is tool-calling over live domain services (`WarehouseInsightTools`), not retrieval over
an embedding store: there is no pgvector extension, no vector column and no embedding anywhere in
the migration chain or the AI module
([ADR 0027](decisions/0027-ai-copilot-over-tool-calls.md)).

The `anthropic` API-key property is validated eagerly by quarkus-langchain4j at startup even when
the provider is not selected, which is why `application.yaml` sets a placeholder and says so inline
(`:110-117`).

## Schedulers

Six `@Scheduled` methods in this repository. Five take their interval from a configuration property
and all five use `ConcurrentExecution.SKIP`:

`WebhookFanoutScheduler`, `WebhookDeliveryScheduler`, `StockPurgeScheduler`,
`KeycloakEventPoller`, `ReplenishmentScheduler`.

The sixth, `LocationFinderService.sweepExpiredReservations`, is hardcoded to `60s` and has no
`SKIP` (`.../layout/service/LocationFinderService.kt:186-193`). It is a single idempotent delete of
expired rows, so overlap is harmless and omitting `SKIP` is defensible; it is also the only
scheduler with no tenant loop. All three departures are undocumented.

The commercial engines bring schedulers of their own when they are present. Their interval keys are
already in `application.yaml`: `karyo.monitors.interval` and `karyo.monitors.delivery-interval`,
`karyo.crossdock.sweep-interval`, `karyo.wave.auto-interval` and `karyo.streaming.interval`.

## Reproducibility

Image builds need `--timestamp 0` (Podman/Buildah) or `SOURCE_DATE_EPOCH=0` (Docker BuildKit)
([ADR 0023](decisions/0023-reproducible-container-images.md)).
`scripts/check-image-reproducibility.sh` audits a fixed list of build sites (`:23-34`, `:64-67`),
and CI runs the audit before it builds either image (`.github/workflows/ci.yml:171`). The list is
fixed, not discovered: a new build site has to be added to it explicitly or it is simply not
checked.

## Related

- [Deploying](../operations/deploying.md) - installing the four containers
- [Operating an installation](../operations/operating-an-installation.md) - running them
- [The runtime configuration store](../configuration/runtime-configuration-store.md) - the database
  property chain
- [Identity and tenancy](identity-and-tenancy.md#schedulers-and-ambient-context) - how schedulers
  handle tenants
