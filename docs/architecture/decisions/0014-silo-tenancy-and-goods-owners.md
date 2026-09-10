# ADR 0014: One installation per operating company; `client_id` is a goods owner, not a permission

**Status:** Accepted

## Context

Karyo is installed for one operating company, on a host that company controls
([ADR 0001](0001-modular-monolith.md), [ADR 0022](0022-compose-four-container-deployment.md)). The
unit that scales is the customer, not a module or a shared service.

Inside one company's warehouse there is usually more than one owner of the goods. A third-party
logistics operator stores several customers' stock in the same racking, and every stock unit,
order, receipt and document belongs to one of them. The operator's own staff physically handle
every owner's goods, often on the same pick route. The owners themselves - through a client portal,
for example - must never see one another's rows.

## Decision

- **One installation serves one operating company.** There is no row-level tenancy between
  companies; a second company gets a second installation with its own database.
- **`client_id` names the goods owner** that owns a row. Every tenant-scoped entity extends
  `TenantEntity` and carries it. Owner `0` is `SYS`, the operating company itself. It is neither an
  administrator nor a privilege.
- **Owner is attribution on a write and scope on a read.** Which owners a principal may read and
  write is decided by its principal kind ([ADR 0015](0015-principal-kind-independent-of-roles.md))
  through `TenantScope` - `readScope()` and `writeScope()` - not by the `client_id` value and not by
  roles.
- **Isolation is enforced in application code only.** Services and repositories apply the resolved
  scope, or an explicit owner predicate, to the queries they run. Hibernate's `tenantFilter` is
  declared on `TenantEntity` and never enabled, and the schema has no row-level security policies.
- **Owner references are plain ids.** No foreign key points at `clients`; the `client_id` columns
  span many modules, and cross-module references are ids validated through lookups
  ([ADR 0007](0007-cross-module-references-by-id.md)). Integrity is reported, not enforced, by
  `GET /api/v1/clients/consistency`.
- **Work that is not a request names its owner explicitly.** Schedulers and port-to-port calls pass a
  `clientId` and, where a context is needed, build one with `TenantContext.ownerScoped(clientId, actor)`.
  They never read the ambient request context: on a scheduled thread the request scope is active but
  unprimed, so its `clientId` silently reads `0`.

**Why the Hibernate filter is not the boundary.** Hibernate filters do not apply to primary-key
`find()` and `get()`, and this codebase loads by id constantly, so a filter-based boundary would look
airtight in review and leak in the most common call. Native queries bypass filters entirely. The
annotations stay declared because they are harmless and could serve a future defence-in-depth layer.

**Why the database does not enforce isolation as a second layer** - PostgreSQL row-level security was
considered and not adopted - is not recorded.

## Consequences

- A company's data never shares a database with another company's, and the deployment model stays
  one host, one instance.
- Owner separation matches the physical warehouse: staff move every owner's goods, and each owner
  sees only its own.
- A query path that forgets the scope is a cross-owner leak with nothing underneath it. Isolation
  holds only as far as every read path applies it, and no route-by-route audit of owner scoping is
  recorded.
- A reader who sees `@FilterDef` and `@Filter` on `TenantEntity` can reasonably conclude that
  repository queries are scoped automatically. They are not.
- **Known defect.** Instance-wide layout - zones, areas, location types, storage areas, working
  areas, clusters, capacity constraints - carries no owner, and its routes gate only on `layout-write`,
  which the `MANAGER` composite holds. A goods owner's own manager can change the racking every owner
  shares.
- **Known defect.** Two fictional goods owners, `ACME Corporation` and `Globex Corporation`, are
  inserted beside `SYS` by a core migration into every installation, and goods owners cannot be
  deleted. Deactivating an owner stops only new users and unit-load transfers for it; receiving,
  picking, packing and shipping continue.

## Alternatives considered

- **One shared installation serving many companies, separated by row.** Rejected. Karyo is installed
  on a customer-controlled host, and with one installation per customer the scaling argument for a
  shared multi-company platform does not arise.
- **A schema or a database per tenant inside one installation.** Rejected. The recorded costs are
  migration fan-out across every tenant schema and connection-pool management per schema or database.
  Under one-installation-per-company, each company already has its own database.
- **Hibernate's filter as the enforcement layer.** Rejected, for the primary-key and native-query
  reasons above.
- **PostgreSQL row-level security as a second barrier.** Considered and not adopted. The reason is
  not recorded.

## Evidence

- `libs/karyo-common/src/main/kotlin/com/karyo/common/domain/BaseEntity.kt:26-30` - `TenantEntity`, its `clientId` defaulting to `0`, and the declared filter
- `libs/karyo-security/src/main/kotlin/com/karyo/security/TenantScope.kt:3-53` - the single place scope decisions are made
- `libs/karyo-security/src/main/kotlin/com/karyo/security/TenantContext.kt:9-11,51-53` - the request context and the explicit-owner factory
- `libs/karyo-security/src/main/kotlin/com/karyo/security/TenantFilter.kt:25-46` - claims read into the context on every authenticated request
- `services/karyo-app/src/main/resources/db/migration/auth/V1201__create_clients.sql:1-35` - the goods-owner table, no foreign keys to it, `SYS` as `0` and the two seeded owners

## Related

- [ADR 0007](0007-cross-module-references-by-id.md) - ids, not foreign keys, across modules
- [ADR 0013](0013-keycloak-oidc.md) - where the `client_id` claim comes from
- [ADR 0015](0015-principal-kind-independent-of-roles.md) - who may see across owners
- [ADR 0018](0018-strategy-driven-configuration.md) - which configuration is per owner and which is instance-wide
- [Identity and tenancy](../identity-and-tenancy.md) - scope resolution and explicit-owner contexts in detail
- [Goods owners and clients](../../configuration/goods-owners-and-clients.md) - administering goods owners
