# ADR 0015: `principal_kind` decides owner scope independently of roles, and its absence means OWNER

**Status:** Accepted

## Context

Two kinds of people sign into one installation ([ADR 0014](0014-silo-tenancy-and-goods-owners.md)).
The operating company's staff handle every goods owner's stock, so their reads and writes must span
owners. A goods owner's own users - through a client portal, for example - must see and touch only
their owner's rows.

Roles cannot carry that distinction. A role says which operation a principal may perform, not whose
goods it may perform it on: an operating-company picker and a goods owner's own warehouse staff can
both hold `OPERATOR`. The security boundary follows who is holding the terminal, not how dangerous
the verb is.

Nor can the owner id carry it. Both `TenantEntity.clientId` and `TenantContext.clientId` default to
`0`, the id of the operating company itself, so a rule that treated owner `0` as "sees everything"
would grant that to every unattributed row and every unprimed context. It would fail open.

## Decision

- **A separate token claim, `principal_kind`, with two values.** `ops` is operating-company staff;
  `owner` is a goods owner's principal. It is minted from a Keycloak user attribute by a mapper on
  both token-issuing clients ([ADR 0013](0013-keycloak-oidc.md)).
- **Resolution fails closed.** `PrincipalKind.fromClaim` maps only `ops` to `OPS`; anything absent or
  unrecognised is `OWNER`. `TenantContext.principalKind` defaults to `OWNER`, and explicit-owner
  contexts built for background work are always `OWNER`.
- **Kind decides scope.** `OPS` resolves to `Unscoped` for both reads and writes; `OWNER` resolves to
  `Owner(clientId)` for both. On an `OPS` write, `client_id` is attribution - whose goods these are -
  not a restriction.
- **Kind and roles are independent axes.** Neither implies the other. An `ADMIN` role does not make a
  principal `OPS`, and owner `0` is not `OPS` by virtue of its id.
- **Granting a kind is strict.** Creating a user requires an explicit kind; an unrecognised value in a
  request is a 400, not a silent downgrade. An `OPS` principal may create either kind; an `OWNER`
  principal may create only `OWNER` principals, because granting `OPS` hands the new user unscoped
  access to every owner.

## Consequences

- A token without the claim - issued before a mapper existed, or by a realm whose mapper is missing -
  gets the restrictive scope rather than the permissive one. Nothing widens by accident.
- The same role vocabulary serves both kinds of principal.
- The failure mode of a misconfigured realm is quiet: a missing mapper narrows every affected user to
  their own owner with no error. Mappers must be kept aligned on both clients and in both realm
  files.
- `readScope()` and `writeScope()` have identical bodies today and are kept separate because their
  reasons differ: read scoping is what makes a client-facing portal safe; write scoping stops one
  owner mutating another's stock, and because mutation endpoints echo the changed row back, an
  unscoped write would also be an unscoped read. Nothing detects a call site that picked the wrong
  one until the two diverge.
- A Keycloak service-account token carries no `principal_kind` and no `client_id`, so it arrives as an
  `OWNER` of owner `0` and can reach almost nothing. That is part of the integration gap recorded in
  [ADR 0013](0013-keycloak-oidc.md).

## Alternatives considered

- **Treat owner `0` as the cross-owner principal.** Rejected: both defaults are `0`, so it fails open.
- **Derive cross-owner scope from a role such as `ADMIN`.** Rejected. A role says what a principal may
  do, not whose goods it may see; an administrator working for a goods owner must stay inside that
  owner.
- **Default an absent claim to `OPS`.** Rejected. A fail-open default would widen every existing or
  misissued token; the fail-closed default keeps tokens without the claim on strict behaviour with no
  read regression.

## Evidence

- `libs/karyo-security/src/main/kotlin/com/karyo/security/PrincipalKind.kt:3-30` - the two kinds and the fail-closed resolution
- `libs/karyo-security/src/main/kotlin/com/karyo/security/TenantFilter.kt:46` - the claim read on every authenticated request
- `libs/karyo-security/src/main/kotlin/com/karyo/security/TenantContext.kt:24,51-53` - `OWNER` by default, and always `OWNER` for explicit-owner contexts
- `libs/karyo-security/src/main/kotlin/com/karyo/security/TenantScope.kt:35-53` - kind to scope, for reads and for writes, with the reason they are separate
- `services/auth-service/karyo-auth-core/src/main/kotlin/com/karyo/auth/service/UserManagementService.kt:154-174` - strict parsing and who may grant which kind
- `infrastructure/keycloak/karyo-realm-prod.json` and `infrastructure/keycloak/karyo-realm.json` - the `principal_kind` mapper on `karyo-web` and `karyo-backend`

## Related

- [ADR 0013](0013-keycloak-oidc.md) - the realm and mappers that mint the claim
- [ADR 0014](0014-silo-tenancy-and-goods-owners.md) - goods owners and where isolation is enforced
- [Identity and tenancy](../identity-and-tenancy.md) - claim extraction and scope resolution
- [Users, roles and permissions](../../configuration/users-roles-and-permissions.md) - creating users of each kind
