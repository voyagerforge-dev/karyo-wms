# Users, roles and permissions

Karyo stores no users. Identity lives entirely in Keycloak
([ADR 0013](../architecture/decisions/0013-keycloak-oidc.md)), and the auth service is "a thin
proxy over the Keycloak Admin API for owner-aware user management ... there is no user table in
auth-service"
(`services/auth-service/karyo-auth-core/src/main/kotlin/com/karyo/auth/service/UserManagementService.kt:27-31`).
Everything an administrator configures here is therefore split between a realm file the
operator imports and a REST surface the product exposes over it.

How a token becomes a scope at request time belongs to
[identity and tenancy](../architecture/identity-and-tenancy.md), and route gating in the
browser to [the frontend](../architecture/frontend.md). This document covers what an
administrator can grant, what they cannot, and where the two role vocabularies in the codebase
disagree.

## Two shipped realms

`infrastructure/keycloak/karyo-realm.json` and `infrastructure/keycloak/karyo-realm-prod.json`
both define realm `karyo` with an identical set of 27 roles and identical protocol mappers.
They differ in exactly one thing: the development realm ships five named users with attributes
and credentials, and the production realm ships none beyond the two service accounts.

The development users are worth knowing because they encode the intended shapes:

| User | Roles | `client_id` | `principal_kind` | `tenant_code` |
|---|---|---|---|---|
| `admin` | `ADMIN` | 0 | ops | SYS |
| `manager` | `MANAGER`, `integration-admin` | 1 | ops | ACME |
| `operator` | `OPERATOR` | 1 | ops | ACME |
| `viewer` | `VIEWER` | 1 | ops | ACME |
| `tenant2-operator` | `OPERATOR` | 2 | owner | GLOBEX |

Only one of the five is an owner principal, so the development realm exercises the restrictive
path in exactly one account. Three ops-kind users carry a non-zero `client_id`, which is
consistent with the model - `principal_kind` decides scope and `client_id` only names the row a
principal belongs to ([ADR 0015](../architecture/decisions/0015-principal-kind-independent-of-roles.md))
- but it does mean the seeded `ACME` staff read across every goods owner.

Four attributes are mapped into the token by both realms: `client_id`, `principal_kind`,
`tenant_code` and `warehouse_id`. There is **no `permissions` mapper in either realm.**

## Twenty atomic roles and seven composites

The realm files carry twenty fine-grained roles (`inventory-read`/`-write`,
`product-read`/`-write`, `layout-read`/`-write`, `order-read`/`-write`, `task-read`/`-write`,
`fulfillment-read`/`-write`, `report-read`/`-write`, `ai-read`/`-write`,
`integration-read`/`-admin`, `user-admin`, `tenant-admin`) and seven composite job roles that
expand into them: `ADMIN`, `MANAGER`, `OPERATOR`, `RECEIVER`, `VIEWER`, `INTEGRATOR`,
`AI_SERVICE`.

`ADMIN` is the only composite carrying `user-admin`, `tenant-admin` and `integration-admin`.
`MANAGER` carries neither `integration-read` nor `integration-admin` in either realm - the
development `manager` user gets `integration-admin` granted directly alongside `MANAGER`, not
through it. That matters, because the frontend's route split exists specifically for that
principal (see below).

### Six roles gate nothing

Counting every `@RolesAllowed` in the backend, twenty-one of the twenty-seven roles are named
somewhere. Six are named nowhere:

| Role | Status |
|---|---|
| `tenant-admin` | No backend use. Nothing in the product checks it |
| `ai-read`, `ai-write` | No backend use. The AI copilot gates on `inventory-read`, `inventory-write` and `fulfillment-write` instead (`services/ai-service/karyo-ai-core/src/main/kotlin/com/karyo/ai/api/v1/CopilotResource.kt:35,55`; `services/ai-service/karyo-ai-core/src/main/kotlin/com/karyo/ai/tools/WarehouseActionTools.kt:53,161`) |
| `integration-read` | No backend use. The webhook resources require `integration-admin` (`services/integration-hub-service/karyo-webhooks-core/src/main/kotlin/com/karyo/webhooks/api/v1/WebhookSubscriptionResource.kt:30`, `services/integration-hub-service/karyo-webhooks-core/src/main/kotlin/com/karyo/webhooks/api/v1/WebhookDeliveryResource.kt:23`) |
| `INTEGRATOR`, `AI_SERVICE` | Named in no `@RolesAllowed`; they work only through the atomic roles they expand into |

Two of these have a practical consequence rather than being merely tidy-up. `INTEGRATOR` is
the shipped role for an integration partner: it grants `integration-read`, which gates nothing,
and withholds `integration-admin`, which gates every webhook route. An administrator who grants
`INTEGRATOR` and expects the holder to manage their own webhook subscriptions is wrong, and
nothing says so. `AI_SERVICE` grants `ai-read`/`ai-write`, neither of which the AI service
checks; it happens to work because it also grants `inventory-read`. What an integrating system
needs instead is in [identity for an integrating system](../integration/identity-for-an-integrating-system.md).

`tenant-admin` is the clearest case of a role that reads as authority and confers none - its
name suggests it governs the Clients screen, which is in fact gated on `user-admin`
(`services/auth-service/karyo-auth-core/src/main/kotlin/com/karyo/auth/api/v1/ClientResource.kt:47,56,62,68,73`).

### Three vocabularies in one product

The codebase gates routes three different ways, and all three are in use:

- **atomic roles** - the dominant idiom: `inventory-write` (36 sites), `order-write` (30),
  `layout-write` (30), `user-admin` (16) and so on
- **composite job roles** - `ADMIN` (9), `MANAGER` (8), `VIEWER` (5), `OPERATOR` (4),
  `RECEIVER` (4)
- **manual checks against `TenantContext.roles`** - the AI tools, which cannot use
  `@RolesAllowed` because the guard runs inside a tool call rather than at a route
  (`WarehouseActionTools.kt:14-22`)

The third is explained where it happens and is fine. The first two are mixed inside single
resources. `ClientResource` reads on composites and writes on `user-admin`
(`ClientResource.kt:41,47,52,56,62,68,73`). `AdminExtensionsResource` requires `ADMIN`
(`services/karyo-app/src/main/kotlin/com/karyo/app/admin/AdminExtensionsResource.kt:50`) while
the admin page that calls it sits behind a `user-admin` route guard
(`frontend/web/src/routes/router.tsx:177-180`, `frontend/web/src/components/auth/admin-guard.tsx:18`).

That last pair has a visible effect. A principal holding `user-admin` without `ADMIN` reaches
Admin -> Extensions (SPI), gets 403 from the live registry, and the page falls back to a
bundled static catalog with an honest note, "Showing bundled catalog (live registry
unavailable)"
(`frontend/web/src/pages/admin/admin-strategies-page.tsx:16-26,208-212`). The degradation is
declared rather than silent, which is to the page's credit - but the fallback catalog lists
nine seams where the live registry lists seventy-seven (see
[the configuration boundary](the-configuration-boundary.md#tier-4-extension-jars)), so the
default administrator persona is the one most likely to be reading the short list.

## "Permissions" means two different things

`TenantContext` has both `roles` and `permissions`, populated from `SecurityIdentity.roles` and
from a `permissions` JWT claim respectively
(`libs/karyo-security/src/main/kotlin/com/karyo/security/TenantFilter.kt:40-41`).

No realm mints a `permissions` claim, and no code reads `TenantContext.permissions`. The AI
tools' KDoc states the position: "`TenantContext.permissions` is a separate custom JWT claim and
is NOT checked by `@RolesAllowed`. Action tools guard on `.roles` to stay in sync"
(`WarehouseActionTools.kt:20-22`).

Meanwhile the frontend's `usePermissions` hook and every `hasPermission('layout-write')` call
in the web app are reading **realm roles**, not that claim: `extractPermissions` returns
`tokenParsed.realm_access.roles`, with the comment "Composite roles are already expanded at
token issuance"
(`frontend/web/src/components/auth/auth-provider.tsx:18-26`,
`frontend/web/src/hooks/use-permissions.ts:8-20`).

So the frontend works correctly and the backend field is dead. The cost is vocabulary: a
reader who sees `permissions` on both sides will reasonably assume they are the same thing, and
one of them is a fine-grained authorisation model that was never built.
`TenantContext.tenantCode` and `TenantContext.locale` are in the same state - written by the
filter, read by nothing (`TenantFilter.kt:38,43`).

## Provisioning a user

`POST /api/v1/users` requires `user-admin` (`api/v1/UserResource.kt:36-38`) and resolves three
things before anything is created.

**The goods owner is never inherited and never defaulted.** `authorizedTargetClient` requires an
explicit `clientId`, checks it against `writeScope`, and requires the client to be ACTIVE. The
comment records why: an omitted `clientId` would otherwise arrive as Jackson's `0L` and silently
attach the user to the SYS system client (`UserManagementService.kt:98-124`). A cross-owner
provisioning act is logged.

**The principal kind is authorised, not copied.** An ops principal may mint either kind; an
owner principal may only mint further owner principals. The reasoning is stated: granting OPS
hands the new user unscoped reads and writes over every goods owner, "which is exactly the
escalation this check exists to prevent - the value must never be inherited from whoever is
calling" (`UserManagementService.kt:154-174`). Parsing is deliberately strict rather than
fail-closed here, because "an unrecognized value in a request body is a caller mistake and must
be a 400, not a silent downgrade" - the opposite of the token path, and correctly so.

**Managing an existing user** goes through `requireManageableUser`, which requires the target's
`client_id` to be in write scope and additionally forbids an owner administrator from touching
an ops-kind account in their own client
(`service/UserAdministrationAccess.kt:12-29`).

The read and write predicates are deliberately separate, and the comments record why:
filtering the listing with the write predicate would hide every ops-kind account inside the
caller's own client, so an owner administrator whose client holds only such accounts would see
an empty page (`UserManagementService.kt:332-349`); using it on the single-user read would mean
a row the listing returned could not be opened (`UserManagementService.kt:398-415`). Visibility
is decided by client scoping; authority to mutate is still decided per mutation. That is a
correct and well-documented split.

### Roles are granted with no allowlist, and two paths disagree

Neither creation nor assignment restricts *which* realm role may be granted. A `user-admin`
holder may grant any role in the realm, including `ADMIN`.

Within owner-scoped administration that is defensible: roles gate routes, `principal_kind`
gates rows, and no role can turn an owner principal into an ops one. The escalation the design
cares about is closed at `grantablePrincipalKind`.

**Known defect.** What is not defensible is that the two grant paths behave differently on an
unknown role:

- `RoleService.assignRole` looks the role up and throws `AuthException.RoleNotFound`
  (`service/RoleService.kt:33-37`)
- `UserManagementService.createUser` catches the same lookup failure, logs "Role $roleName not
  found during user creation, skipping", and continues (`UserManagementService.kt:64-77`)

So creating a user with a mistyped role returns 201 with a user who silently holds fewer roles
than requested, while assigning that same role afterwards returns a clean error. An
administrator's first indication is an operator who cannot do their job.

### A user cannot be re-homed, and cannot be removed

`updateUser` writes email, first name, last name and `warehouse_id` only
(`UserManagementService.kt:234-252`). Neither `client_id` nor `principal_kind` is writable
after creation, which is consistent with the escalation guard - re-homing a user would be a
scope change with no authorisation path.

There is also no delete: `UserResource` offers deactivate and reactivate and nothing else
(`api/v1/UserResource.kt:63-72`). Deactivation is the right default for an audit trail, and
matches how clients are retired. Together, though, the two mean a user provisioned against the
wrong goods owner can only be disabled and replaced, and the disabled account stays in the
listing forever. Nothing states this as a decision; it is what the code does.

## `warehouse_id` is collected and read by nothing

`warehouse_id` is offered on the user creation form
(`frontend/web/src/pages/users/user-form.tsx:267-270`), stored as a Keycloak attribute
(`UserManagementService.kt:136-138`), mapped into the token by both realms, read into
`TenantContext.warehouseId` (`TenantFilter.kt:42`), returned on `UserResponse`
(`UserManagementService.kt:445`) and displayed on the user detail page as "Warehouse"
(`frontend/web/src/pages/users/user-detail.tsx:107`).

Nothing else in the backend reads it. There is no `Warehouse` entity, no `warehouses` table and
no query anywhere filtered by it. An administrator filling in that field is recording a note.

The field is not an oversight in isolation - it is the visible edge of Karyo being
single-warehouse per installation, which is a real and stated design position. **Known
defect:** the product collects and displays a scoping value it does not scope by, on the screen
where an administrator is deciding what a user may reach.

## What the admin UI cannot express

The user form offers exactly seven roles: the composite job roles
(`frontend/web/src/types/user.ts:47-50`, rendered at `user-form.tsx:313-317`). None of the
twenty atomic roles is offerable.

An administrator using the shipped product therefore cannot grant `integration-admin` without
also granting `ADMIN` - and `ADMIN` carries `user-admin`, `tenant-admin` and every write role in
the system. The frontend's own route split exists precisely to serve the principal that cannot
be created this way: `AdminShell` is deliberately ungated and split into two nested guards so
that "a principal holding only `integration-admin` (e.g. `manager`) can reach
/admin/integrations without also holding the broader `user-admin`"
(`frontend/web/src/routes/router.tsx:163-171`, mirrored in
`frontend/web/src/config/admin-navigation.ts:40-48`).

That principal exists in the development realm only because the realm file grants the atomic
role directly. Through the product, the split is unreachable.

There is a second surface with the same shape. The admin shell's "Users & roles" entry does not
open the product's own user page - it deep-links to the Keycloak admin console, justified in a
comment as honesty: "Users & roles honestly deep-links out to the Keycloak admin console (no
local user store exists) instead of faking a page"
(`frontend/web/src/config/admin-navigation.ts:19-28`).

The premise is true and the conclusion is stale. There is no local user store, but there *is* a
working user administration page at `/users` in the operational shell
(`frontend/web/src/routes/router.tsx:125-128`, `frontend/web/src/pages/users/`), backed by the
full `UserResource` surface - create, list, update, deactivate, reactivate, reset password,
manage roles (`api/v1/UserResource.kt:36-79`). The administrator is sent to Keycloak past a
page the product ships. Keycloak remains the only way to grant an atomic role, so the deep link
is still needed; the comment's reason for it is not the real one.

## Related

- [Identity and tenancy](../architecture/identity-and-tenancy.md) - how a token becomes a scope
- [The frontend](../architecture/frontend.md) - route guards and role gating in the browser
- [Goods owners and clients](goods-owners-and-clients.md) - the clients a user belongs to
- [Identity for an integrating system](../integration/identity-for-an-integrating-system.md) - service accounts and machine principals
- [ADR 0013](../architecture/decisions/0013-keycloak-oidc.md) and [ADR 0015](../architecture/decisions/0015-principal-kind-independent-of-roles.md)
