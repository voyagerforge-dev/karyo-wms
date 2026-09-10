# ADR 0018: Tunable behaviour is strategy-driven, through a family of patterns rather than one rule

**Status:** Accepted

## Context

Karyo has to work with nothing configured, and still let a deployment tune how stock is chosen,
where it is put away, how short picks and pack-out are handled, how work is dispatched and how
documents are numbered - and let an implementer replace a behaviour without forking the source.

Some of those knobs are values an administrator sets. Others are algorithms only code can express.
Some are properties of the whole warehouse; some belong to one goods owner
([ADR 0014](0014-silo-tenancy-and-goods-owners.md)).

## Decision

Tunable behaviour is expressed as a default plus a knob, through four mechanisms. Each exists for a
different kind of knob, and each has its own scope and selection rule.

1. **Named strategy entities, edited by an administrator.**
   - `OrderStrategy` - instance-wide (no owner), unique name, typed columns for reservation, picking,
     short-pick, pack-out and progression behaviour, and a JSONB `extension_properties` map. A
     `DEFAULT` row is seeded by migration. An order names its strategy by id; `OrderStrategyResolver`
     beans are consulted in ascending priority, the first non-null name wins, and the built-in
     resolver sits last and falls back to `DEFAULT`.
   - `StorageStrategy` - per goods owner, bound to a product (or named by the putaway request). There
     is no seeded default; with none bound, putaway runs on the finder's built-in constants.
2. **The runtime property store** (`system_properties`), resolved per key through a ladder: the
   owner's row, then the instance-wide row for owner `0`, then the MicroProfile configuration value,
   then the caller's default. A code-owned catalogue gives known keys a type, group, description and
   default, and two flags: `secret` masks the value in every read, and `ownerWritable = false` keeps a
   goods owner from overriding an operator's hard stop.
3. **MicroProfile configuration** (`karyo.*` in `application.yaml`, overridable by environment
   variable) for instance-wide knobs read at start-up.
4. **CDI strategy beans** for behaviour, compiled into the build
   ([ADR 0019](0019-extensions-compile-into-the-build.md)). Selection is decided per seam:
   - filter chains - every implementation runs in ascending priority and its order is honoured
     (`StockSelectionFilter`, `LocationFilter`);
   - first non-null wins, built-in registered at `Int.MAX_VALUE` so it runs last
     (`PutawayLocationStrategy`, `OrderStrategyResolver`);
   - named match first, then ascending priority (`PackoutStrategy`, `ReplenishmentStrategy`);
     `CarrierAdapter` claims by carrier name;
   - selected by name, where an unknown name is a hard failure (`WorkDispatchStrategy` at dispatch,
     `SequenceNumberGenerator` at start-up, `CountScopeStrategy` per request);
   - direct CDI injection with no priority at all (`WebhookSigner`, `DeliveryRetryPolicy`).

New knobs are placed deliberately: a stable, commonly used value is a typed field; long-tail or
experimental configuration is a JSONB key; new behaviour is a strategy bean.

## Consequences

- An installation that configures nothing gets coherent behaviour: the `DEFAULT` order strategy always
  resolves, and every built-in strategy sits behind any custom one.
- Administrators tune by data without a redeploy; implementers extend by code.
- There is no universal selection rule. An implementer has to read each seam's resolver to know how a
  bean wins, and the same word, "priority", means activation in one place and chain order in another.
- Scope differs by mechanism. `OrderStrategy` is instance-wide, so one holder of `order-write` changes
  order handling for every goods owner, while `StorageStrategy` is per owner. `OrderStrategyContext`
  carries the order's `clientId` and the built-in resolver ignores it. Why order strategy is
  instance-wide while every other strategy entity is per owner is not recorded.
- Name validation differs. The name-selected seams fail loudly; the free-text strategy names on
  `OrderStrategy` (short-fall, pick difference, pack-out) are validated by nothing and fall through to
  the priority chain, so a typo can quietly select a different strategy than the one intended.
- The JSONB map carries Karyo's own configuration for the commercial wave and streaming engines as
  fourteen un-namespaced keys with no validation, in the space extension authors are told to
  namespace. `StorageStrategy` has no such map.
- Values can be accepted and ignored. A non-catalogue key stored for a knob that is read only from
  MicroProfile configuration is persisted, listed and has no effect.
- Neither strategy entity can be deleted, and a mistyped storage-strategy id on a product saves
  cleanly and is ignored at putaway.
- Most `karyo.*` knobs have not moved onto the runtime store and remain instance-wide and
  restart-only. Whether they were assessed and kept there is not recorded.

## Alternatives considered

- **One unified configuration object.** Rejected. It becomes unwieldy; per-domain strategies group
  related knobs and bind to different operations.
- **Configuration by code only.** Rejected. Operators could not tune anything without a rebuild and a
  redeploy.
- **A rules engine binding strategies by order type, priority or wave, built up front.** Rejected as
  premature. The resolver seam takes an operation context, so new inputs can be added later without
  changing the strategy entities or breaking existing resolvers.
- **One priority-and-first-non-null rule for every seam.** Not what the code does, and deliberately
  so where it matters: priority selection let a custom bean silently displace a default, so work
  dispatch, numbering and count scope select by name and refuse an unknown one. An unnamed count-scope
  resolve would otherwise escalate a targeted cycle count into a warehouse-wide freeze.

## Evidence

- `services/order-service/karyo-orders-core/src/main/kotlin/com/karyo/orders/domain/model/OrderStrategy.kt:10-22,104` - instance-wide, unique name, the JSONB relief valve, `DEFAULT`
- `services/karyo-app/src/main/resources/db/migration/orders/V405__seed_default_order_strategy.sql` - the seeded `DEFAULT`
- `services/order-service/karyo-orders-api/src/main/kotlin/com/karyo/orders/spi/OrderStrategyResolver.kt:3-39` - the binding seam and its context
- `services/order-service/karyo-orders-core/src/main/kotlin/com/karyo/orders/service/DefaultOrderStrategyResolver.kt:19-24` - the built-in resolver and its fallback
- `services/warehouse-layout-service/karyo-layout-core/src/main/kotlin/com/karyo/layout/domain/model/StorageStrategy.kt:6-8` - storage strategy per goods owner
- `services/auth-service/karyo-auth-core/src/main/kotlin/com/karyo/auth/config/SystemPropertyService.kt:10-25` - the resolution ladder
- `services/auth-service/karyo-auth-core/src/main/kotlin/com/karyo/auth/config/SystemPropertyCatalog.kt:13-24,27-34` - `secret`, `ownerWritable`, and non-catalogue keys
- `services/warehouse-layout-service/karyo-layout-api/src/main/kotlin/com/karyo/layout/spi/PutawayLocationStrategy.kt:6-37` - first non-null wins, built-in last
- `services/fulfillment-service/karyo-fulfillment-core/src/main/kotlin/com/karyo/fulfillment/service/PackoutStrategyResolver.kt:27-33` - named match, then the priority chain
- `services/stocktaking-service/karyo-stocktaking-core/src/main/kotlin/com/karyo/stocktaking/service/CountScopeStrategyResolver.kt:8-26` - selection by name, and why
- `services/karyo-app/src/main/resources/application.yaml:192-201` - dispatch and numbering selected by name
- `services/work-service/karyo-work-core/src/main/kotlin/com/karyo/work/service/WorkDispatchService.kt:54` and `libs/karyo-sequence/src/main/kotlin/com/karyo/sequence/SequenceNumberService.kt:26` - unknown names refused

## Related

- [ADR 0014](0014-silo-tenancy-and-goods-owners.md) - goods owners, and which configuration follows them
- [ADR 0019](0019-extensions-compile-into-the-build.md) - how a strategy bean reaches an installation
- [Strategies and policies](../../configuration/strategies-and-policies.md) - the two strategy entities in full
- [Runtime configuration store](../../configuration/runtime-configuration-store.md) - the property ladder and catalogue
- [Strategies and runtime configuration](../../integration/strategies-and-runtime-configuration.md) - the same mechanisms from an implementer's side
