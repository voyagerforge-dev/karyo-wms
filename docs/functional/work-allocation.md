# Work allocation

The work inbox is the floor's single queue. Five modules publish into it, one service orders it,
and one operator pulls from it. It is also the thinnest layer in the functional stack, and the
place where two real defects are easiest to hit.

## The shape

`WorkProvider` (`services/work-service/karyo-work-api/.../spi/WorkProvider.kt:15-30`) is a
five-method SPI: `workTypes()`, `listOpen(filter)`, `listClaimedBy(operatorId)`,
`claim(ref, operatorId)` and `release(ref, operatorId, asManager)`. Each provider is a thin
adapter over its own module's service, never over its repository - claim and release write
through the owning service so its guards cannot be bypassed.

Four providers cover eight work types:

| Provider | Types |
|---|---|
| `PickWorkProvider` (fulfillment) | `PICK` |
| `ReceivingWorkProvider` (orders) | `RECEIVE` |
| `CountWorkProvider` (stocktaking) | `COUNT` |
| `TransportWorkProvider` (tasks) | `PUTAWAY`, `MOVE`, `REPLENISH`, `TRANSFER`, `CROSS_DOCK` |

`WorkItem` is a live read shape, never persisted
(`karyo-work-api/.../dto/WorkItem.kt:20-54`). `WorkRef` is the cross-type identity, serialised as
`TYPE:id` and parsed back on every claim (`:8-18`).

Two `WorkItem` fields are populated by only some providers, and both KDocs say so rather than
pretending otherwise:

- `primaryLocationId` - null for `PICK`, because pick orders have no location concept yet. That
  is called "a documented gap, not a bug", and it has a behavioural consequence spelled out at
  the same site: a null location means the item is **excluded** whenever `?workingAreaId=` is
  applied, "deliberately: an operator scoped to a working area shouldn't be shown work with no
  known location" (`:32-41`). So filtering the inbox by working area hides every pick.
- `travelOrder` - populated only by `CountWorkProvider`, and read only by `TRAVEL_PATH` dispatch
  (`:42-53`).

## Dispatch

`WorkDispatchService.poolFor` (`.../service/WorkDispatchService.kt:113-121`) resolves the
operator's eligible types, asks every provider that overlaps them for its open items, narrows by
working area, and hands the merged list to the active `WorkDispatchStrategy` to order.

`getNext` (`:126-135`) walks that ordered pool and claims the first item that does not throw
`WorkClaimConflictException`, skipping anything it lost a race for. That is why every provider
translates its own module's refusals - wrong state, paused, not found - into that one exception
type: anything else would abort the dispatch loop rather than skip a candidate
(`.../tasks/messaging/TransportWorkProvider.kt:52-71`).

### Dispatch strategies

Selected **by name**, not by priority: `karyo.work.dispatch-strategy`, default
`STRICT_PRIORITY` (`.../service/WorkDispatchConfig.kt:17-19`).

- `STRICT_PRIORITY` - `priority DESC, createdAt ASC`
  (`.../service/StrictPriorityDispatchStrategy.kt:18-19`).
- `TRAVEL_PATH` - `travelOrder NULLS LAST, priority DESC, createdAt ASC`
  (`.../service/TravelPathDispatchStrategy.kt:33-38`). Opt-in. Items without a travel order sort
  after those that have one and then fall back to the strict ordering among themselves, "so a
  mixed pool ... degrades to `StrictPriorityDispatchStrategy`'s behavior for the items this
  strategy has no spatial opinion about, rather than scattering them arbitrarily" (`:11-16`).

Selection by name rather than by priority is deliberate, and it changes what deploying an
extension does: priority-based resolution would let "ANY custom strategy under `Int.MAX_VALUE`
silently win" (`WorkDispatchService.kt:69-77`), so a lower-priority bean could take over the
default just by being deployed. An unmatched name is a hard failure - `error()`, uncaught -
rather than a silent fallback to some other registered strategy.

That failure is checked at **boot**, not only at dispatch, because the name is deployment config
fixed for the process lifetime (`validateOnStartup:48-57`). Duplicate strategy names also fail
boot, since two beans sharing a name would resolve in CDI discovery order.

### Eligibility

`DefaultWorkEligibilityResolver` (`.../service/DefaultWorkEligibilityResolver.kt:22-30`):

- a tenant with **no** work groups configured - the operator is eligible for **all** work types
  ("system open until configured");
- otherwise - the union of work types across the operator's group memberships, and a non-member
  sees nothing.

Groups store their types as a comma-joined string and `resolve` calls `WorkType.valueOf` on each
element. The REST layer validates the names on create (`validateWorkTypes`,
`.../api/v1/WorkInboxResource.kt:53-59`), so this only bites if the column is written another way
or an enum value is later removed - the same class of trap `JournalRecordType`'s KDoc warns about
for its own codes.

## Claiming

Two routes reach a claim, and they are not gated the same way.

**`POST /api/v1/work/{ref}/claim`** (`WorkInboxResource.kt:89-98`) is annotated with the union of
every write role, then calls `requireWriteRole(workRef.type)` in the body to enforce the *actual*
role for that type, and additionally refuses a type the operator is not eligible for.

**`POST /api/v1/work/next`** (`:77-82`) is `@RolesAllowed("inventory-read")` and calls
`dispatch.getNext`, which claims (`WorkDispatchService.kt:126-135`). It calls
`requireWriteRole` nowhere.

Claiming is a real write, so the inbox gates it per work type by design: a per-type write-role
map gates `claim` and `release`, fail-closed.

**Known defect.** `/next` claims too and is not covered by the map, so a principal holding only
`inventory-read` can still take any work type - including a pick or a count - by asking for the
next item instead of naming one.

### The map has a hole

```kotlin
private val WRITE_ROLE_BY_TYPE: Map<WorkType, String> = mapOf(
    WorkType.PICK to "fulfillment-write",
    WorkType.RECEIVE to "order-write",
    WorkType.COUNT to "inventory-write",
    WorkType.PUTAWAY to "task-write",
    WorkType.MOVE to "task-write",
    WorkType.REPLENISH to "task-write",
    WorkType.TRANSFER to "task-write",
)
```
`WorkInboxResource.kt:146-154`

`CROSS_DOCK` is missing, and the lookup is `getValue`:

```kotlin
val required = WRITE_ROLE_BY_TYPE.getValue(type)
```
`:47`

**Known defect.** `getValue` throws `NoSuchElementException` on a missing key. There is no
generic exception mapper in this repository, so that becomes an HTTP 500 - not the fail-closed
403 the map exists to give.

The path is real, not theoretical. `TransportWorkProvider.workTypes()` includes `CROSS_DOCK`
(`.../messaging/TransportWorkProvider.kt:25-26`) and `listOpen` filters by those names, so a
cross-dock transport order is genuinely offered as claimable work and appears in
`/api/v1/work/available`. Claiming or releasing it **by ref** returns 500; taking it via `/next`
succeeds, because that route never consults the map.

Only the cross-docking engine creates `CROSS_DOCK` orders, through
`TransportOrderPort.createCrossDock`, so a free installation never reaches this path.

## Release

`POST /api/v1/work/{ref}/release` (`WorkInboxResource.kt:105-114`) applies the same per-type gate,
then computes `asManager = tenantContext.roles.contains("inventory-write")` and hands it to the
provider. Each module's own release honours it - a non-owner needs manager authority, otherwise
409, never 403. Note the manager check is a *different* role from the per-type write role, so for
a PICK the caller needs `fulfillment-write` to release at all and `inventory-write` to
force-release someone else's.

## A stale note

`ReceivingWorkProvider`'s class KDoc still says the inbox gates `claim`/`release` uniformly at
`inventory-read`/`inventory-write` for every work type, and describes the resulting
viewer-can-claim-a-receipt asymmetry as a pre-existing, inbox-wide design posture
(`.../orders/messaging/ReceivingWorkProvider.kt:24-36`).

The per-type map replaced that posture for `claim` and `release`, so the KDoc describes behaviour
the code no longer has. It is still accurate about `/next`, though for a different reason than it
gives.

## Related

- [Picking](picking.md), [Putaway](putaway-and-location-finding.md),
  [Stocktaking](stocktaking.md), [Receiving](receiving-and-quality-holds.md) - the four sources of
  work
- [Frontend](../architecture/frontend.md) - how roles reach the request
- [Users, roles and permissions](../configuration/users-roles-and-permissions.md) - which role
  carries which write permission
