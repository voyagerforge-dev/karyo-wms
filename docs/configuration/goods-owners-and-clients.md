# Goods owners and clients

A **client** in Karyo is a goods owner - a 3PL's customer, the party whose stock sits in the
building. It is the entity behind the `client_id` that every tenant-scoped row carries
(`services/auth-service/karyo-auth-core/src/main/kotlin/com/karyo/auth/domain/model/Client.kt:10-16`).
The mechanics of how that id scopes a read or a write belong to
[identity and tenancy](../architecture/identity-and-tenancy.md); this document covers what an
administrator creates, changes and cannot change.

The distinction between a client and a tenant is deliberate and stated in the admin
navigation: Karyo is silo tenancy, one instance per company
([ADR 0014](../architecture/decisions/0014-silo-tenancy-and-goods-owners.md)), so "Tenants" would
be a future SaaS concept and is not the same thing as a Client
(`frontend/web/src/config/admin-navigation.ts:19-28`). The Tenants entry on the admin sidebar
is a placeholder with no backend.

## The model

`Client` extends `BaseEntity`, not `TenantEntity`, and the KDoc says why: "a client *is* the
tenant dimension and so carries no `client_id` of its own" (`Client.kt:10-16`). Fields are
`name`, `number`, `code`, `email`, `phone`, `fax` and a numeric `state`
(`Client.kt:22-41`). `number` is the business key; `name` is unique too.

Both uniqueness rules are enforced twice: in the service before insert
(`service/ClientService.kt:210-216`) and by unique indexes in the schema
(`services/karyo-app/src/main/resources/db/migration/auth/V1201__create_clients.sql:22-23`).
That is the right belt-and-braces order - the service check produces a clean 409, the index
catches the race.

`isSystemClient` is derived from `id == 0` and is deliberately not a column, because "id 0 is
also `TenantEntity`'s default, so the two must never be able to disagree"
(`Client.kt:43-50`). That is a good reason recorded in the right place.

## Retirement, not deletion

`ClientState` defines exactly two states, `ACTIVE` (100) and `INACTIVE` (900)
(`services/auth-service/karyo-auth-api/src/main/kotlin/com/karyo/auth/vo/ClientState.kt:11-13`).

There is no delete, and the reason is stated where it belongs: "Clients are never deleted - 26
entity types may reference one and there are no foreign keys to tell us whether removal is safe
- so `INACTIVE` is the retirement path" (`ClientState.kt:7-9`). This is the single best piece
of rationale in the configuration area, and it is worth quoting because the same reasoning is
not applied to storage locations, which are in the same position and do have a hard delete -
see [what the system refuses](warehouse-layout-configuration.md#what-the-system-refuses) in
warehouse layout configuration.

Retirement is not cosmetic. `requireActiveById` exists separately from `requireById` precisely
so that reading a retired owner stays legitimate while attaching new work to one does not, and
the comment names the design intent: "Keeping the state check here makes it a server-side
invariant rather than a convention the create form happens to follow"
(`service/ClientService.kt:57-71`). Today the only caller is user creation.

## Who may administer a goods owner

The authority split is by *principal kind*, not by role
([ADR 0015](../architecture/decisions/0015-principal-kind-independent-of-roles.md)), and this is
one of the few places in the codebase where that distinction is load-bearing.

Creating a client refuses an OWNER principal outright: "Creating a goods owner is platform
administration. A goods-owner principal has no business minting new tenants, and unlike the
id-bearing paths below there is no existing row here for a scope check to compare against"
(`service/ClientService.kt:74-80`). The consistency report refuses the same way, "even while
holding user-admin" (`service/ClientService.kt:143-148`).

For the id-bearing paths, scoping does the work. Reads use `readScope` and report an
out-of-scope row as absent rather than forbidden, because "a 403 would confirm the row exists
to a principal not entitled to know that" (`service/ClientService.kt:49-55`). Mutations use
`writeScope` because "every mutation endpoint echoes the full `ClientResponse` back, so an
unscoped write would also be an unscoped read" (`service/ClientService.kt:32-33`). The system
client is protected from mutation, and the ordering is deliberate: the scope check runs first
so an out-of-scope principal cannot distinguish "system client" from "not yours"
(`service/ClientService.kt:193-208`).

Every one of those is a considered decision with its reasoning attached, and all of them hold.

### The route roles do not match that care

`ClientResource` gates its reads on the composite job roles and its writes on the atomic one:

| Route | Role |
|---|---|
| `GET /api/v1/clients`, `GET /{id}` | `VIEWER`, `OPERATOR`, `RECEIVER`, `MANAGER`, `ADMIN` |
| `GET /consistency`, `POST`, `PUT /{id}`, deactivate, reactivate | `user-admin` |

(`services/auth-service/karyo-auth-core/src/main/kotlin/com/karyo/auth/api/v1/ClientResource.kt:40-74`.)

Mixing the two vocabularies in one resource has a concrete effect: the shipped `INTEGRATOR` and
`AI_SERVICE` composites hold neither `VIEWER` nor any of the other four, so neither can list
goods owners, while `inventory-read` - which both hold - lets them read stock rows carrying a
`client_id` they cannot resolve to a name. See
[users, roles and permissions](users-roles-and-permissions.md#three-vocabularies-in-one-product).

## `number` is immutable, and that is load-bearing

`update` writes `name`, `code`, `email`, `phone` and `fax`, and does not write `number`
(`service/ClientService.kt:112-135`). Nothing says why, but the code settles it: when a user is
created, the client's `number` is copied onto the Keycloak user as the `tenant_code` attribute
(`service/UserManagementService.kt:131-135`), from where a realm protocol mapper puts it in
every token. A mutable `number` would leave every existing user carrying a stale copy with no
reconciliation path.

The wrinkle is that `tenant_code` is itself read by nothing (see
[users, roles and permissions](users-roles-and-permissions.md#permissions-means-two-different-things)),
so the invariant protects a value that has no consumer.

## The consistency report

Because no foreign keys reference `clients` - "the 24 client_id columns span 12 modules, and
the modulith rule is IDs-only across module boundaries" (`V1201__create_clients.sql:4-6`;
[ADR 0007](../architecture/decisions/0007-cross-module-references-by-id.md)) - integrity is
advisory and there is a report for it: `GET /api/v1/clients/consistency` returns every
`client_id` present in operational data with no matching row
(`repository/ClientRepository.kt:19-56`).

It discovers its own tables rather than listing them, by scanning `information_schema` for
every base table in the schema with a `client_id` column, so it stays correct as modules add
tables. Views are excluded deliberately, and the reason is recorded: the schema has reporting
views that copy `client_id` from an already-validated base table, so scanning them would be
redundant and "a latent false-positive source if a future view ever synthesizes `client_id`"
(`ClientRepository.kt:19-30`).

This is the right shape for a system that chose IDs-only over foreign keys: it does not pretend
the integrity is enforced, it gives an administrator a way to check. Two details are worth
knowing. The migration comment says 24 `client_id` columns and `ClientState` says 26 entity
types; the report itself counts at runtime, so neither number is authoritative and the drift is
harmless. And the report only finds *dangling* ids - it says nothing about a location or a
product whose client row exists but is INACTIVE.

## Every installation ships with two fictional customers

**Known defect.** `V1201__create_clients.sql` seeds three rows and then advances the identity
sequence to 100:

```
(0, 'System',             'SYS',    'SYS')
(1, 'ACME Corporation',   'ACME',   'ACME')
(2, 'Globex Corporation', 'GLOBEX', 'GLOBEX')
```

(`V1201__create_clients.sql:28-35`.)

Client 0 is load-bearing: it is the system client and `TenantEntity`'s default, and the
instance-wide rung of the runtime property ladder is keyed to it. ACME and Globex are demo
data. The migration's own comment describes the insert as a backfill of client ids already
present in live data (`V1201__create_clients.sql:25-27`), yet it is hardcoded into a migration
that runs in every installation.

`db/migration/auth` is in the unconditional Flyway location list
(`services/karyo-app/src/main/resources/application.yaml:40`), there is no demo location set,
and no later migration removes the rows. A production installation therefore starts with two
fictional goods owners in its clients list, on the Clients admin screen, and in every
client-picker in the product. They cannot be deleted - clients never are - so the best an
implementation consultant can do is deactivate them, leaving two retired companies in the list
permanently.

This is not for want of a home for demo data. Karyo has a demo service with its own
configuration knob and a `@PreMatching` filter that makes every demo route return 404 when it
is off, described as "the enforcement of the 'inert/invisible in prod' invariant"
(`services/demo-service/karyo-demo/src/main/kotlin/com/karyo/demo/config/DemoConfig.kt:7-16`,
`services/demo-service/karyo-demo/src/main/kotlin/com/karyo/demo/api/v1/DemoEnabledFilter.kt:10-26`).
The clients seed bypasses it.

The contrast with the other seeding migrations is instructive: unit load types and the DEFAULT
order strategy are genuine reference data and are seeded idempotently with `ON CONFLICT ... DO
NOTHING` (`db/migration/inventory/V105__seed_unit_load_types.sql`,
`db/migration/orders/V405__seed_default_order_strategy.sql`). The clients insert has no
conflict guard and hardcodes ids.

## Related

- [Identity and tenancy](../architecture/identity-and-tenancy.md) - how `client_id` scopes a request
- [Users, roles and permissions](users-roles-and-permissions.md) - who may administer clients and users
- [Reference data](reference-data.md) - what else a fresh installation starts with
- [ADR 0014](../architecture/decisions/0014-silo-tenancy-and-goods-owners.md) - silo tenancy and goods owners
