# The runtime configuration store

Karyo has a runtime-editable configuration store, reached at `/api/v1/system-properties` and
presented as **Admin -> System properties**. It is the only part of the configuration surface a
person can change on a running instance without a restart. Its catalog is written to grow "as
existing `@ConfigProperty` knobs migrate onto the runtime store"
(`services/auth-service/karyo-auth-core/src/main/kotlin/com/karyo/auth/config/SystemPropertyCatalog.kt:27-34`).

The catalog holds sixteen keys. Every other `karyo.*` knob is environment-only - see
[the configuration boundary](the-configuration-boundary.md#tier-3-environment-knobs).

## Two halves: a code-owned catalog and stored values

The design splits metadata from values, deliberately and clearly. The set of known keys, their
types, groups, descriptions and defaults live in code, in `SystemPropertyCatalog`
(`SystemPropertyCatalog.kt:36-170`). Only the value is stored, in `system_properties`
(`SystemProperty.kt:19-38`, table created by
`services/karyo-app/src/main/resources/db/migration/auth/V1202__create_system_properties.sql`).

The entity KDoc states the reason: catalog metadata "is code-owned in [SystemPropertyCatalog],
never stored - a row only carries the value plus optional free-text description/group so that
non-catalog (extension/custom) keys remain self-describing" (`SystemProperty.kt:15-17`). That
is a sound split. A key's type is a property of the code that reads it, so letting an
administrator edit the type would let them break a consumer.

A row is keyed by `(client_id, property_key, property_context)`, unique with `NULLS NOT
DISTINCT` so at most one null-context row exists per client and key (`V1202`, and
`SystemProperty.kt:10-13`).

## The four-rung ladder

Every read resolves through the same ordered fallback
(`SystemPropertyService.kt:146-157`, contract stated at `SystemPropertyService.kt:10-29`):

1. a stored row for the exact client
2. the stored **client 0** row - the instance-wide fallback for every goods owner
3. the MicroProfile config value for the same key (`application.yaml` or an environment variable)
4. the caller-supplied default

Rung 3 is what makes the store an override rather than a replacement. A module keeps its
`@ConfigProperty` bean; that value is demoted to the bottom of the ladder and the stored row
wins. `ReceivingConfig`'s KDoc says so directly: the environment value is "the FALLBACK
DEFAULT, not the authority"
(`services/order-service/karyo-orders-core/src/main/kotlin/com/karyo/orders/config/ReceivingConfig.kt:21-24`).

A stored row whose value is null never satisfies a rung; `DELETE` is the way to unset
(`SystemPropertyService.kt:10-29`, `:80-84`). There is no caching, and the class says why: the
consumers are per-request admin and config paths, hot paths are not expected consumers yet, and
the stated lever if one appears is a short-TTL layer rather than widening the class
(`SystemPropertyService.kt:20-24`). That is a rationale worth keeping - it names the next move
instead of leaving it to be rediscovered.

## The 16 keys, and who they belong to

| Key | Type | Group | Default | Owner-writable | Needs a commercial engine |
|---|---|---|---|---|---|
| `karyo.receiving.allow-over-receipt` | BOOLEAN | Receiving | `true` | no | - |
| `karyo.alerts.email.recipients` | STRING | Alerts | none | yes | monitors |
| `karyo.alerts.slack.webhook-url` | STRING | Alerts | none | no (secret) | monitors |
| `karyo.replenishment.from-picking` | BOOLEAN | Replenishment | `false` | yes | - |
| `karyo.packing.cartonization.max-lines-per-box` | INTEGER | Packing | `1` | yes | cartonization |
| `karyo.packing.cartonization.max-amount-per-box` | INTEGER | Packing | `0` | yes | cartonization |
| `karyo.shipping.rename-unit-load` | BOOLEAN | Shipping | `false` | yes | - |
| `karyo.inventory.purge.retention-days` | INTEGER | Inventory | `30` | no | - |
| `karyo.crossdock.pre-distributed` | BOOLEAN | Cross-docking | `false` | yes | advanced-fulfillment |
| `karyo.crossdock.opportunistic` | BOOLEAN | Cross-docking | `false` | yes | advanced-fulfillment |
| `karyo.crossdock.staging-window` | INTEGER | Cross-docking | `4` | no | advanced-fulfillment |
| `karyo.crossdock.expiry-action` | STRING | Cross-docking | `AUTO_PUTAWAY` | no | advanced-fulfillment |
| `karyo.wave.auto-release` | BOOLEAN | Waves | `false` | yes | advanced-fulfillment |
| `karyo.streaming.enabled` | BOOLEAN | Streaming | `false` | yes | advanced-fulfillment |
| `karyo.threepl.rate.storage-per-ul-day` | STRING | 3PL Billing | none | no | three-pl |
| `karyo.threepl.currency` | STRING | 3PL Billing | `USD` | no | three-pl |

All sixteen are defined at `SystemPropertyCatalog.kt:38-165`. Twelve of the sixteen are read only by
a commercial engine - the last column names the entitlement it needs. Those engines are not in this
repository, so in a free installation nothing reads those twelve keys at all; the store neither
knows nor says so - see [the configuration boundary](the-configuration-boundary.md).

For the four keys whose consumers are in this repository, each catalog default matches the
default the consumer passes at the call site: `OverReceiptGuard.kt:44-46`,
`ReplenishmentService.kt:60`, `ShippingService.kt:125` and `StockPurgeService.kt:21-22,119`.
They agree, but nothing enforces the agreement: the catalog's `defaultValue` is display metadata
used by `resolveView` (`SystemPropertyService.kt:129-144`), while the value a consumer actually
falls back to is the argument it passes to `getBoolean`/`getInt`/`getString`. Two sources of
truth that happen to be in step.

## Two kinds of privilege, expressed two different ways

The catalog carries two flags, and both are about privilege rather than behaviour.

**`ownerWritable = false`** means only an ops principal may write the key. The rationale is
recorded where it is enforced: a goods-owner administrator "must not be able to loosen an
operator-set hard stop by writing its own client row above the client-0/env fallback"
(`SystemPropertyCatalog.kt:19-23`; enforced at
`services/auth-service/karyo-auth-core/src/main/kotlin/com/karyo/auth/api/v1/SystemPropertyResource.kt:104-114`).
Reads are unaffected. The refusal is 403 rather than 404 or 422, and the resource says why: the
key's existence is public catalog metadata, so only the privilege is secret
(`SystemPropertyResource.kt:97-103`).

The ops-controlled keys are the over-receipt hard stop, the Slack webhook, the purge retention
window, the cross-dock staging window and expiry action, and the 3PL storage rate and billing
currency. The catalog states the distinction it is drawing each time: box sizing and rung
toggles are "a warehouse-ops preference with no security surface", while an audit horizon and
"how long staged stock is allowed to sit and what happens when it doesn't move" are
operational-safety policy, and the billing keys "ARE the numbers a goods owner is invoiced
against" (`SystemPropertyCatalog.kt:66-69`, `:89-93`, `:100-107`, `:148-154`). That line is
drawn consistently across all sixteen keys.

**`secret = true`** makes a key write-only in the effective view: any present value is replaced
by a mask literal for every principal, ops included, while the source label stays truthful
(`SystemPropertyCatalog.kt:13-17`, `SystemPropertyService.kt:101-109`, mask at
`SystemPropertyService.kt:171`). Only the view is masked - the typed getters hand in-process
consumers the real value, which is what makes the Slack channel work. Exactly one key is
secret.

The masking is not defeated by the admin screen: the property editor seeds an empty draft for a
secret key rather than the mask, so a save cannot round-trip the mask back into storage
(`frontend/web/src/pages/admin/admin-properties-page.tsx:109,121,177`).

## Scoping: who may target which client

An owner principal reads and writes only its own client's rows. An ops principal defaults to
client 0 - the instance-wide scope - and may target any client through `?clientId=` or the body
(`SystemPropertyResource.kt:29-37`, `:116-130`). An owner naming another client gets 422 rather
than 404, and the resource explains the choice: an upsert names no existing row, so there is
nothing whose existence a 404 would have to hide (`SystemPropertyResource.kt:33-37`).

Every route is `@RolesAllowed("user-admin")` (`SystemPropertyResource.kt:54,66,80`), the same
composite the frontend admin routes gate on - one of the few places in the codebase where the
frontend gate and the backend gate agree. See
[users, roles and permissions](users-roles-and-permissions.md) for the places they do not.

## The property context is stored, offered and never read

`SystemProperty.propertyContext` is documented as an "Optional finer scope (e.g. a
workstation); null = the client-wide row" (`SystemProperty.kt:26-28`). It is part of the unique
key, the repository can look a row up by it (`SystemPropertyRepository.kt:10-21`), the service
accepts it on upsert and delete (`SystemPropertyService.kt:62,80`), the REST layer takes it in
the body and as a query parameter (`SystemPropertyResource.kt:69,82`), the effective view
surfaces context rows as extras (`SystemPropertyService.kt:92-98`), and the admin screen ships
a **"Save override"** form with a context input whose placeholder reads `Context (e.g.
client:2)` (`frontend/web/src/pages/admin/admin-properties-page.tsx:255-290`).

No consumer ever reads one. The resolution ladder queries the null-context row on every rung
and only the null-context row (`SystemPropertyService.kt:146-157`, calling
`repository.findValue(clientId, key, null)`), and it is the only path the typed getters and
`RuntimePropertyLookup` use. A context override is therefore stored, echoed back, listed on the
screen, and inert.

**Known defect.** It is the sharpest one in the configuration area because the product invites
the mistake: an ops administrator following the placeholder to scope a value to client 2 gets a
row that changes nothing, while the ladder's real per-owner mechanism - a row written against
that `clientId` - sits one field away and works.

## Non-catalog keys are accepted, stored and ignored

The catalog is not a whitelist. `validate` returns early for an unknown key
(`SystemPropertyService.kt:159-167`) and `set` stores it as-is, so any key at all can be
written; the class comment sanctions this for "extension/custom knobs", which "simply get no
type validation and no metadata in the effective view" (`SystemPropertyCatalog.kt:30-32`).

For a custom extension that reads its own key back through `RuntimePropertyLookup`, that is a
genuine relief valve and a good one. For an administrator, it is a trap. The environment knobs
listed in [the configuration boundary](the-configuration-boundary.md#tier-3-environment-knobs)
are exactly the kind of key someone would try here - `karyo.replenishment.scan-interval`,
`karyo.work.dispatch-strategy` - and storing one has no effect at all, because their consumers
hold an injected `@ConfigProperty` value resolved once at construction and never consult the
store. The screen accepts the write, shows the row under a "Custom" group, and reports success.

There is a second, quieter gap in the same area. `effectiveView` builds its extras from
`repository.listByClient(clientId)` (`SystemPropertyService.kt:92-98`), which returns only that
client's own rows. A non-catalog key stored at client 0 is therefore invisible to a goods
owner's screen even though rung 2 of the ladder would resolve it for them. The screen is
labelled as the effective view; for non-catalog keys it is not.

## The cross-module read contract

Other modules do not depend on auth-core. They inject `RuntimePropertyLookup`, an interface in
auth-api with a single implementation that delegates to the typed getters
(`services/auth-service/karyo-auth-api/src/main/kotlin/com/karyo/auth/spi/RuntimePropertyLookup.kt:17-26`,
`services/auth-service/karyo-auth-core/src/main/kotlin/com/karyo/auth/service/DefaultRuntimePropertyLookup.kt:11-24`).

Its KDoc is unusually explicit about what it is not: "This is a cross-module read contract, not
a strategy seam: there is no plausible second implementation, and none should be added"
(`RuntimePropertyLookup.kt:14-16`). It is also deliberately unscoped by tenant - callers pass
the domain row's own `client_id`, and production call sites are already tenant-guarded
(`RuntimePropertyLookup.kt:11-13`). Both statements are the kind of rationale that would
otherwise survive only in someone's head, and both hold: five modules in this repository
consume it and only auth implements it.

`RuntimePropertyLookup` is nevertheless listed in the live SPI registry the admin Extensions
page reads (`services/karyo-app/src/main/kotlin/com/karyo/app/admin/AdminExtensionsResource.kt:95`),
because that list includes every interface declared in an `spi` package, and the registry does
not distinguish an in-process read contract like this one from a genuine extension point
(`AdminExtensionsResource.kt:83-86`). See
[the configuration boundary](the-configuration-boundary.md#tier-4-extension-jars).

## Related

- [The configuration boundary](the-configuration-boundary.md) - the store against environment, JAR and core work
- [Users, roles and permissions](users-roles-and-permissions.md) - the `user-admin` gate and principal kinds
- [Strategies and runtime configuration](../integration/strategies-and-runtime-configuration.md) - the same store seen by an integrating system
- [Runtime and configuration](../architecture/runtime-and-configuration.md) - where environment configuration is read
