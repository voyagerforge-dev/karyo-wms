# ADR 0022: Compose with four containers is the supported deployment

**Status:** Accepted

## Context

Karyo is tenanted by silo: one instance per operating company (ADR 0014), on a host that company
or its implementer controls. The application is one deployable (ADR 0001), and it needs three
things beside it: a PostgreSQL database (ADR 0004), Keycloak for identity (ADR 0013), and a web
server that serves both front ends and the API from one origin (ADR 0016).

The scaling unit is the customer, not a module, and every module releases together, so nothing in
the product consumes independent scaling or independent deployment of its parts. Whatever runs the
stack is operated by the customer or their implementer, on one host, for the life of the
installation, and its fixed overhead is paid by every installation.

## Decision

- **The supported deployment is `infrastructure/docker/docker-compose.prod.yml`:** four containers
  on one bridge network, with one named volume for the database.

  | Service | Image | Role |
  |---|---|---|
  | `postgresql` | `postgres:16-alpine` | the database; Keycloak's own database lives in the same server |
  | `keycloak` | `quay.io/keycloak/keycloak:26.0` | identity |
  | `karyo-app` | built from `infrastructure/docker/Dockerfile.service` | the application, which migrates the schema at boot |
  | `nginx` | built from `infrastructure/docker/Dockerfile.nginx` | both front ends, and the reverse proxy for the API and Keycloak |

- **Only nginx publishes a host port**, and it listens on plain HTTP. PostgreSQL, Keycloak and the
  application are reachable only on the Compose network. TLS, where an installation has it,
  terminates in front of the stack; nothing in this repository configures a certificate.
- **`scripts/deploy-server.sh` is the installation mechanism.** It checks the host, builds both
  images from source, renders one environment file into a file per service so that each container
  receives only its own values, and brings the stack up in dependency order behind healthchecks.
  Docker with the Compose plugin and Podman with `podman-compose` are both supported.
- **One host, one instance.** There is no orchestrator, no second replica and no rolling restart.

## Consequences

- The whole deployment is one file an operator can read, and it runs on any host with a container
  runtime - one virtual machine, or one machine in the warehouse.
- **Every deploy is an outage.** The deploy script stops the running stack before it starts the new
  one, and its header says to plan for that. With one instance there is nothing to fail over to.
- Nothing survives a redeploy except what is in the database volume. The containers are removed,
  and their logs with them (ADR 0026).
- The application's memory is capped by Compose (`mem_limit`, 1536 MiB unless `APP_MEM_LIMIT`
  says otherwise), not by an orchestrator's scheduler.
- The deploy script builds both images on the target host, so that host carries a JDK and a Node
  toolchain.
- The images it builds are tagged `:latest` unless `KARYO_APP_IMAGE` and `KARYO_NGINX_IMAGE` say
  otherwise. Why the default is a mutable tag is not recorded.
- Horizontal scaling, zero-downtime upgrades and high availability are not available. A second
  application instance would not be safe as the product stands: the webhook relay's schedulers lock
  no rows, so two instances would deliver every event twice (ADR 0009).
- The application build also declares the Quarkus Kubernetes and Jib extensions, so every
  `quarkusBuild` writes Kubernetes manifests under `services/karyo-app/build/kubernetes/`. Nothing
  uses them; the images come from the two Dockerfiles. Why the extensions are declared is not
  recorded.

## Alternatives considered

- **Kubernetes, with a lightweight distribution for small sites.** Rejected. Its auto-scaling,
  self-healing and rolling updates each depend on having more than one replica of something, which
  one instance per company does not have. It costs specialised operational knowledge and a control
  plane whose overhead is significant against one modest host - a cost every installation would pay
  for as long as it runs.
- **Pull-based continuous delivery, with a controller reconciling the cluster against a
  configuration repository.** Rejected with Kubernetes: it assumes a cluster, and the controller is
  one more service to deploy and keep available. A single-host deployment is re-run by one script.
- **An API gateway product in front of the application.** Rejected. With one application behind it
  there is no routing across services to centralise; nginx serves the front ends and proxies the
  API and Keycloak from one configuration file. Rate limiting, which a gateway would have supplied,
  exists nowhere in the stack, and whether that is a decision is not recorded.
- **Mutual TLS between internal services through a service mesh.** Rejected: there are no
  service-to-service calls inside the application to protect. It reaches PostgreSQL and Keycloak
  over the private Compose network.

## Evidence

- `infrastructure/docker/docker-compose.prod.yml:7-131` - the four services, one network, one
  volume
- `infrastructure/docker/docker-compose.prod.yml:109-110` - the one published port
- `infrastructure/docker/docker-compose.prod.yml:76,105` - the `:latest` defaults
- `infrastructure/docker/docker-compose.prod.yml:87` - the memory cap
- `infrastructure/docker/nginx/nginx.conf:89` - nginx listens on plain HTTP
- `infrastructure/docker/init-db.sh:10-12` - Keycloak's database in the same server
- `scripts/deploy-server.sh:4-8` - the installation mechanism, and its warning to plan an outage
- `scripts/deploy-server.sh:659-675` - both images built on the target host
- `scripts/deploy-server.sh:736-747` - the running stack is stopped before the new one starts
- `services/karyo-app/build.gradle.kts:107-108` - the Jib and Kubernetes extensions
- [Deploying](../../operations/deploying.md)
- [Runtime and configuration](../runtime-and-configuration.md)

## Related

- [ADR 0001](0001-modular-monolith.md) - one deployable
- [ADR 0014](0014-silo-tenancy-and-goods-owners.md) - one instance per operating company
- [ADR 0016](0016-two-frontends-same-origin.md) - both front ends served from one origin
- [ADR 0023](0023-reproducible-container-images.md) - how the two images are built
- [ADR 0026](0026-json-structured-logging.md) - where the logs go, and why they do not survive a
  deploy
