# Identity and tenancy

Who a request is, which goods owner's data it may touch, and what actually enforces that.

Derived from `libs/karyo-security/`,
`libs/karyo-common/src/main/kotlin/com/karyo/common/domain/BaseEntity.kt`, the migration chain and
`services/karyo-app/src/main/resources/application.yaml`.

## Silo tenancy

One instance per operating company
([ADR 0014](decisions/0014-silo-tenancy-and-goods-owners.md)). `client_id` is a goods owner inside
that instance, not a separate SaaS customer, and not a permission. Id 0 is SYS.

`principal_kind` (`ops` or `owner`) and operation roles are independent axes
([ADR 0015](decisions/0015-principal-kind-independent-of-roles.md)). `PrincipalKind` and role
membership answer different questions and neither implies the other.

## Claim extraction

`TenantFilter` is a JAX-RS `ContainerRequestFilter`
(`libs/karyo-security/src/main/kotlin/com/karyo/security/TenantFilter.kt:17-46`). It returns early
for anonymous requests (`:25-26`), then populates a `@RequestScoped` `TenantContext` from JWT
claims: `client_id`, `tenant_code`, username, roles, `permissions`, `warehouse_id`, `locale`,
`principal_kind`.

Two details matter, because getting either wrong fails silently:

- `client_id` is read through a four-branch `when` (`:29-37`). Quarkus OIDC returns custom numeric
  claims as the JSON-P type `JsonNumber`, which is not a `java.lang.Number`, so the `JsonNumber`
  branch must come first or every non-zero `client_id` silently reads as 0.
- `principal_kind` resolution is fail-closed. `PrincipalKind.fromClaim` maps only `"ops"` to `OPS`;
  anything absent or unrecognised becomes `OWNER`, the restrictive option
  (`libs/karyo-security/src/main/kotlin/com/karyo/security/PrincipalKind.kt:12-29`). A token without
  the claim therefore gets the strict behaviour.

## Scope resolution

`TenantScope` is a sealed interface with `Unscoped` and `Owner(clientId)`, and one `permits`
function (`libs/karyo-security/src/main/kotlin/com/karyo/security/TenantScope.kt:21-33`).
`readScope()` and `writeScope()` both resolve `OPS` to `Unscoped` and `OWNER` to `Owner(clientId)`
(`:35-53`).

The two functions have identical bodies and are kept separate on purpose. `TenantScope.kt` records
why (`:16-19`): the reasons differ and are expected to diverge. Read scoping is what makes a
client-facing read-only portal safe; write scoping is what stops one goods owner mutating another's
stock. The write-side KDoc adds a second reason (`:41-49`) - mutation endpoints echo the mutated
row back, so an unscoped write would also be an unscoped read.

That is sound. The cost is that while the bodies are identical, nothing detects a call site that
picked the wrong one, and every such site becomes a bug on the day they diverge.

`TenantScope`'s KDoc says "Every owner check ... goes through [permits] rather than comparing
`client_id` inline" (`:6-9`). That holds for principal-scoped checks. It is not literally true of
the code: dozens of inline `clientId` comparisons remain in main source, and the ones inspected are
entity-to-entity same-owner consistency checks (does this unit load belong to the same owner as
that carrier), which are a different question from principal scoping and outside what `permits`
models. The claim is imprecise rather than wrong. The same KDoc points at "the design doc, §8",
which is not in this repository.

## Explicit-owner contexts

`TenantContext.ownerScoped(clientId, actor)` builds a synthetic context for callers that already
hold an explicit `clientId` and must never read ambient state
(`libs/karyo-security/src/main/kotlin/com/karyo/security/TenantContext.kt:28-55`).

The trap it exists for is specific and is documented in that KDoc: on a `@Scheduled` thread and on
direct port-to-port calls the request scope **is active but unprimed**, so the injected bean's
`clientId` is still the default 0. Reading it there is a silent wrong-tenant read, not an error.
`.../replenishment/service/ReplenishmentScheduler.kt:29-44` carries a correction that shows how
easily the opposite is assumed: its KDoc once claimed the scope was never active on a scheduler
thread, and two transitive calls did read ambient state.

Two properties of `ownerScoped` deserve emphasis:

- `principalKind` is fixed to `OWNER`, so scope is strict `clientId` equality and never the
  OPS-style unscoped view. That strictness is the whole point of the overload existing.
- `actor` is attribution only. It names who audit rows belong to and never widens what may be read
  or written. Not every explicit-`clientId` caller is a scheduler; several are REST paths where the
  entity rather than the request owns the goods and a real human is present, so the ambient
  username is passed through and the journal keeps naming the operator.

## What actually enforces isolation

Application code, and only application code.

There is no PostgreSQL row-level security (see
[Data and persistence](data-and-persistence.md#no-row-level-security)). And the Hibernate
`@FilterDef`/`@Filter` named `tenantFilter`, declared on `TenantEntity` (`BaseEntity.kt:26-27`) and
therefore inherited by all 29 tenant-scoped entities, is **never enabled**. No `enableFilter` call
exists anywhere in the repository, main or test.

Repositories and services must therefore apply scope, or an explicit owner predicate, themselves.
Nothing applies it automatically to every query.

### Why the filter is declared but not enabled

Hibernate filters do not apply to primary-key `find()`/`get()`, and this codebase is
`findById`-heavy, so a filter-based boundary would look airtight in review and leak in the most
common call. Native queries bypass filters entirely as well.

So the filter was rejected as the primary boundary for a precise technical reason - it would create
false confidence exactly where the code most often reads - and the annotations are kept only as a
hook for a future defence-in-depth layer. It is a decision, not neglected scaffolding.

Any description of `TenantEntity` that lists the filter without saying it is inert misleads its
reader: the declared filter takes no part in enforcement.

There is no scoped repository layer either. `TenantScope`'s KDoc anticipates one arriving as a
"mechanical swap" (`TenantScope.kt:7-9`); it waits on an owner-facing portal, and no such portal
exists.

## Schedulers and ambient context

Schedulers pass an explicit `clientId` down rather than relying on ambient context. This is the
doctrine `ownerScoped` exists to serve.

One scheduler is the exception. `LocationFinderService.sweepExpiredReservations` deletes expired
soft reservations in a single statement across all tenants, with no `clientId` at all
(`.../layout/service/LocationFinderService.kt:186-193`). That is correct for this job -
reservation expiry is tenant-independent and the reaper exists so a crashed putaway cannot
permanently block a location - but it is the only scheduler that departs from the pattern, and it
also happens to be the only one without `ConcurrentExecution.SKIP` and the only one with a
hardcoded rather than configurable interval. None of that is written down.

## Keycloak

OIDC through the `karyo-backend` client; user administration through `karyo-admin` with client
credentials (`application.yaml:45-56`, [ADR 0013](decisions/0013-keycloak-oidc.md)). The two
clients are kept separate. Realm claim mappers must stay aligned across both token-issuing clients
in the development and production realms, since a claim that exists in one realm and not the other
produces exactly the fail-closed `OWNER` default described above, silently.

`KeycloakEventPoller` in the aggregator polls Keycloak events on
`{karyo.auth-audit.poll-interval}` and maps them to `JournalRecordType`
(`services/karyo-app/src/main/kotlin/com/karyo/app/auth/KeycloakEventPoller.kt:52`). This is why
`karyo-inventory-api` is declared on the aggregator's main classpath rather than only its test
classpath, and the build file says so (`services/karyo-app/build.gradle.kts:38-40`).

## Related

- [Users, roles and permissions](../configuration/users-roles-and-permissions.md) - the roles and
  what each one may do
- [Goods owners and clients](../configuration/goods-owners-and-clients.md) - the goods-owner model
- [Identity for an integrating system](../integration/identity-for-an-integrating-system.md) -
  tokens for machines
- [Data and persistence](data-and-persistence.md) - the schema side of the same story
