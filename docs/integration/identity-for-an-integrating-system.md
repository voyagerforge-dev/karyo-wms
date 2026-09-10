# Identity for an integrating system

What a caller must present to reach `/api/v1`, who can issue it, and what the roles mean.
[Identity and tenancy](../architecture/identity-and-tenancy.md) owns silo tenancy, `principal_kind`
and what does and does not enforce isolation; this document covers the same machinery from the
outside - as a contract an integrating system has to satisfy.

## 1. The token contract

Karyo is an OIDC resource server ([ADR 0013](../architecture/decisions/0013-keycloak-oidc.md)).
`application.yaml:43-47` binds it to one issuer (`${OIDC_URL}`, `/realms/karyo` by default) and one
audience client id, `karyo-backend`. There is no API key, no basic auth and no shared-secret header:
`@HeaderParam` appears nowhere in the main source tree, and the only request header read anywhere is
`X-Correlation-Id` in `TenantFilter.kt:51`.

`libs/karyo-security/.../TenantFilter.kt:24-47` is the single place a token becomes a request
identity. It reads seven things:

| Claim | Field | Absent behaviour |
|---|---|---|
| `client_id` | `TenantContext.clientId` | `0` - the SYS client, which owns no goods |
| `principal_kind` | `TenantContext.principalKind` | `OWNER` - fail-closed, `PrincipalKind.kt:25-29` |
| `tenant_code` | `TenantContext.tenantCode` | `""` |
| `warehouse_id` | `TenantContext.warehouseId` | `null` |
| `locale` | `TenantContext.locale` | `"en"` |
| `permissions` | `TenantContext.permissions` | empty set |
| realm roles (via `SecurityIdentity.roles`) | `TenantContext.roles` | empty set |

`client_id` is read defensively across three JSON shapes because SmallRye returns a custom numeric
claim as a Jakarta JSON `JsonNumber`, which is not a `java.lang.Number` (`TenantFilter.kt:29-37`).
`principal_kind` defaults to the restrictive value so a token issued without the claim keeps strict
behaviour (`PrincipalKind.kt:11-14`;
[ADR 0015](../architecture/decisions/0015-principal-kind-independent-of-roles.md)).

Two of the seven are read and never used. `TenantContext.permissions` is consumed by no decision
anywhere - `WarehouseActionTools.kt:20-22` explicitly notes that authorisation runs off `.roles` and
that `.permissions` "is a separate custom JWT claim". `TenantContext.locale` has exactly one
reference in the whole tree, the assignment in `TenantFilter.kt:43`. Neither claim is minted by any
protocol mapper in either realm export, so both are dead on both ends.

## 2. Who can mint a token

Both realm exports - `infrastructure/keycloak/karyo-realm.json` (development) and
`infrastructure/keycloak/karyo-realm-prod.json` (production) - define exactly three Karyo clients:

| Client | Public | Standard flow | Direct access grants | Service account |
|---|---|---|---|---|
| `karyo-web` | yes | **yes** | no | - |
| `karyo-backend` | no | no | no (development realm: **yes**) | yes |
| `karyo-admin` | no | no | no | yes |

`karyo-web` is the browser front end. Its redirect URIs and web origins are pinned to
`${KARYO_PUBLIC_ORIGIN}` and its front-end callback paths. `karyo-backend` is the resource server's
own identity; `karyo-admin` is the Keycloak Admin REST client Karyo uses for user management (see
[Deploying](../operations/deploying.md)).

**Known defect: an integrating system cannot obtain a production token.** In the production realm,
the only flow that issues a user token is `karyo-web`'s authorization-code flow. Direct access
grants are disabled on all three clients; the development realm enables them on `karyo-backend`
only. So an integrating system cannot obtain a Karyo API token except by driving a browser through
Keycloak's login page. Karyo's own end-to-end suite does exactly that -
`tests/e2e/fixtures/auth.ts:35` fills the `#password` field on the Keycloak form rather than
requesting a grant.

The two service accounts cannot substitute, and not only because no client-credentials audience is
configured for the API. All four Karyo claims are minted by `oidc-usermodel-attribute-mapper`
protocol mappers on `karyo-web` and `karyo-backend`, which read **user attributes**; the service
account users in both exports carry no attributes. A client-credentials token would therefore arrive
with no `client_id` (so `clientId` reads 0, the SYS client that owns no goods) and no
`principal_kind` (so `OWNER`, the restrictive scope) - which is to say, scoped to a tenant with
nothing in it. Neither realm export defines a client an integrating system could use.

## 3. Two role vocabularies

The realm defines 27 roles: 20 fine-grained (`inventory-read`, `order-write`, `user-admin`,
`integration-admin`, ...) and 7 composites (`ADMIN`, `MANAGER`, `OPERATOR`, `RECEIVER`, `VIEWER`,
`INTEGRATOR`, `AI_SERVICE`) whose members are drawn from the fine-grained set.

`@RolesAllowed` in the application checks **both vocabularies directly**:

| Vocabulary | Where it gates |
|---|---|
| Fine-grained (`inventory-*`, `layout-*`, `order-*`, `fulfillment-*`, `product-*`, `task-*`, `report-*`, `user-admin`, `integration-admin`) | Almost every route: inventory, layout, orders, product, tasks, fulfillment, work, stocktaking, replenishment, reporting, auth, webhooks |
| Composite names (`VIEWER`, `OPERATOR`, `MANAGER`, `ADMIN`, `RECEIVER`) | The client list's read routes (`ClientResource.kt:41`, `:52`), the document archive (`DocumentResource.kt:33`, `:44`, `:55`), the demo-data generator (`DemoResource.kt:48`, `:54`, `:65`) and the extension registry (`AdminExtensionsResource.kt:50`) |

Across the free build the counts are 34 `inventory-write`, 30 `layout-write`, 28 `order-write`,
26 `inventory-read`, 25 `layout-read`, 19 `fulfillment-write`, 16 `user-admin`, 12
`fulfillment-read` and 11 `order-read`, down to 2 `integration-admin`; against 4 of the five-name
list `("VIEWER", "OPERATOR", "RECEIVER", "MANAGER", "ADMIN")`, 3 of `MANAGER`+`ADMIN`, 1 `VIEWER`
and 1 `ADMIN`.

The practical consequence is not stylistic. A composite grant puts both the composite name and its
members into the token, so a `MANAGER` satisfies `@RolesAllowed("inventory-read")`. The reverse does
not hold: a principal granted only fine-grained roles satisfies no composite-name gate, so it cannot
read the document archive or the client list however many fine-grained roles it holds. Which
vocabulary a new route should use is not recorded anywhere.

## 4. `INTEGRATOR` is defined and unusable

The realm ships a composite named for exactly the caller this document is about:

```
INTEGRATOR -> inventory-read, order-read, order-write, product-read, product-write, integration-read
```

Three things are wrong with it as delivered.

**`integration-read` is enforced nowhere.** It exists in both realm exports and in the front end's
`Permission` union (`frontend/web/src/types/auth.ts:20`), and no `@RolesAllowed` in the backend
names it. The webhook resources - the only integration surface there is - are both
`@RolesAllowed("integration-admin")` (`WebhookSubscriptionResource.kt:30`,
`WebhookDeliveryResource.kt:23`), which `INTEGRATOR` does not hold. An `INTEGRATOR` can therefore
not list, create, inspect or redeliver anything in the integration hub.

**`INTEGRATOR` holds no composite name**, so it fails every gate in §3's second row.

**It has no client to authenticate through.** By §2 the only production token source is the browser
front end, so an `INTEGRATOR` would have to be a human signing in at a browser - which is not what
the role is named for.

`tenant-admin`, `ai-read` and `ai-write` are in the same position as `integration-read`: present in
both realms and in the front end's role union, enforced by no `@RolesAllowed` in the backend. The
copilot's action tools check fine-grained roles such as `inventory-write` and `fulfillment-write`
(`WarehouseActionTools.kt:53`, `:161`), so the `AI_SERVICE` composite's AI roles grant nothing
either. The only composite that carries `integration-admin` is `ADMIN`.

The front end's union is itself inverted on this exact point. `frontend/web/src/types/auth.ts:1-23`
declares the type `Permission` with the KDoc "These match the @RolesAllowed annotations on backend
services". Its integration entries are `integration-read` and `integration-write`.
`integration-write` appears in neither realm export and in no `@RolesAllowed` anywhere, and
`integration-admin` - the role that actually gates both webhook resources - is not in the union at
all; nor are `fulfillment-read` and `fulfillment-write`, which are enforced. (The type's name is
also a third use of the word: it lists realm *roles*, not the `permissions` JWT claim of §1, which is
separate and dead.)

## 5. `X-Correlation-Id` does not reach the journal

A caller might reasonably expect to send `X-Correlation-Id` on a sequence of related requests and
then find every journal row those requests wrote with
`GET /api/v1/journals?correlationId=...`. **No such path exists.**

`TenantFilter.kt:51` puts the header into SLF4J's MDC and nothing else; MDC is read back by nothing
in the tree (the only four `MDC` references in main source are the import and the three `MDC.put`
calls in that filter). `InventoryJournal.correlationId` is populated from domain strings by the
callers that write a journal row: `"stock-reserver"` by default (`StockReserver.kt:20`), a pick-order
number (`PickOrderService.kt:606`), a cross-dock key `"cross-dock:{orderNumber}"`
(`DefaultCrossDockOrdersPort.kt:67`, `:88`), and the Keycloak session id for authentication-audit
rows (`KeycloakEventPoller.kt:120`).

So `GET /api/v1/journals?correlationId=<what the client sent>` returns nothing, always. The header
is visible only in a container log line, and container logs do not survive a redeploy (see
[Operating an installation](../operations/operating-an-installation.md)). With tracing disabled in
both profiles, the journal is the only correlation mechanism there is, and the client-facing half of
it is not implemented.

## Related

- [Identity and tenancy](../architecture/identity-and-tenancy.md) - `principal_kind`, scope resolution, and what enforces isolation
- [Users, roles and permissions](../configuration/users-roles-and-permissions.md) - administering the roles above
- [The error contract](api-error-contract.md) - what a 401 or 403 looks like
- [Webhooks and the event catalogue](webhooks-and-the-event-catalogue.md) - the only push surface, and its `integration-admin` gate
