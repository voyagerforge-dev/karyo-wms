# ADR 0013: Keycloak is the mandatory OpenID Connect provider

**Status:** Accepted

## Context

Karyo is signed into by operators on shared floor devices, by office staff at desks and by
administrators, and it has to support integrating systems. It is installed on a host the operating
company controls, so identity has to run there too; a hosted identity service would make every
installation depend on a third party and on that party's pricing.

The security features a warehouse installation needs - brute-force protection, multi-factor
authentication, federation with a corporate directory, session management, an audit of sign-ins -
are exactly the ones that are expensive and risky to build.

## Decision

- **Keycloak is the only identity provider.** There is no built-in user store and no alternative
  authentication mode. It runs as its own container, proxied by nginx at `/auth/`
  ([ADR 0022](0022-compose-four-container-deployment.md)).
- **The application validates bearer tokens with Quarkus OIDC** against the `karyo` realm, as the
  `karyo-backend` client.
- **The realm has three Karyo clients:**
  - `karyo-web` - public; used by both front ends; authorization code with PKCE (`S256`) and
    `check-sso`; exact redirect URIs under `KARYO_PUBLIC_ORIGIN` for `/`, `/m/` and their silent
    check pages; no direct access grants.
  - `karyo-backend` - confidential service account; the token audience the application validates
    and the account that reads Keycloak events and users for the sign-in audit.
  - `karyo-admin` - confidential service account used only for user administration through the
    Keycloak admin API.
- **Karyo's own claims come from user attributes** through mappers on both token-issuing clients:
  `client_id`, `principal_kind`, `tenant_code` and `warehouse_id`
  ([ADR 0014](0014-silo-tenancy-and-goods-owners.md), [ADR 0015](0015-principal-kind-independent-of-roles.md)).
- **Roles are realm roles:** fine-grained permissions such as `inventory-read` and `order-write`, and
  composites (`ADMIN`, `MANAGER`, `OPERATOR`, `RECEIVER`, `VIEWER`, `INTEGRATOR`, `AI_SERVICE`).
- **Two realm definitions ship.** The development realm carries demonstration users. The production
  realm carries no human users: the first administrator is provisioned from one-time bootstrap
  credentials supplied at deployment, and bootstrap access is then retired.
- **Sign-ins are audited from Keycloak.** A scheduled poller reads the Keycloak events API and
  journals `LOGIN`, `LOGOUT` and `LOGIN_FAILED` ([ADR 0010](0010-crud-with-an-inventory-journal.md)).

## Consequences

- Authentication is standard OpenID Connect. Federation, multi-factor authentication and brute-force
  protection (on in the production realm, five failures) come from Keycloak rather than from Karyo
  code, and tokens are validated locally once the signing keys are fetched.
- Keycloak is a fourth container with its own database schema and memory footprint, and its start,
  including the first realm import, gates the application's start.
- A revoked token stays valid until it expires.
- Mappers must stay aligned across both token-issuing clients and both realm files. A missing mapper
  does not fail: the claim is simply absent and the application falls back to its restrictive
  defaults.
- A realm file is imported only when the realm does not yet exist, so changing an installed realm is
  a maintenance procedure rather than a redeploy ([Deploying](../../operations/deploying.md)).
- **Known defect.** An integrating system cannot obtain a usable production token. Direct access
  grants are off on every client, `karyo-web` is the only client with a standard flow and it is bound
  to the deployment's own origin, and a service-account token carries none of Karyo's claims, so it
  arrives as goods owner 0 with the restrictive principal kind. The `INTEGRATOR` composite holds
  `integration-read`, which gates nothing, and not `integration-admin`, which gates the webhook
  routes. Four realm roles gate nothing at all: `integration-read`, `tenant-admin`, `ai-read` and
  `ai-write`.

## Alternatives considered

- **A hosted identity service (Auth0, Firebase Authentication).** Rejected. It cannot run on a
  customer-controlled host, per-user pricing is prohibitive when one warehouse has fifty to two
  hundred operators, and it moves identity data out of the customer's control.
- **Karyo's own authentication and token issuing.** Rejected. Authentication is a solved problem, and
  building it in-house means owning every security property - federation, multi-factor
  authentication, brute-force protection, audit - that an identity provider supplies.
- **Keycloak as optional, with a built-in fallback user store.** Not adopted. The cost recorded
  against it is two authentication code paths to maintain; no other reason is recorded.

## Evidence

- `services/karyo-app/src/main/resources/application.yaml:42-56` - OIDC validation as `karyo-backend`, and the `karyo-admin` admin client
- `services/karyo-app/src/main/resources/application.yaml:207-210` - the sign-in audit poller's switch and interval
- `infrastructure/keycloak/karyo-realm-prod.json` - the production realm: three clients, their flows, mappers and roles, no human users
- `infrastructure/keycloak/karyo-realm.json` - the development realm
- `frontend/web/src/lib/keycloak.ts:176-181` and `frontend/mobile/src/lib/keycloak.ts:145-150` - `check-sso`, PKCE `S256` and the silent check pages
- `services/karyo-app/src/main/kotlin/com/karyo/app/auth/KeycloakEventPoller.kt:14-20` - sign-in events polled through the `karyo-backend` service account
- `scripts/deploy-server.sh:183-190` - the one-time bootstrap credentials required for a fresh production realm
- `infrastructure/docker/nginx/nginx.conf:141-142` - Keycloak proxied at `/auth/`

## Related

- [ADR 0014](0014-silo-tenancy-and-goods-owners.md) - what `client_id` means
- [ADR 0015](0015-principal-kind-independent-of-roles.md) - what `principal_kind` means and why it fails closed
- [ADR 0016](0016-two-frontends-same-origin.md) - the two front ends that share `karyo-web`
- [Identity and tenancy](../identity-and-tenancy.md) - claim extraction and scope resolution
- [Users, roles and permissions](../../configuration/users-roles-and-permissions.md) - the role vocabulary in use
- [Identity for an integrating system](../../integration/identity-for-an-integrating-system.md) - the machine-caller gap in full
