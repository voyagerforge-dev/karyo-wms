# Extension SPIs and how one is installed

What Karyo lets an implementer replace, how an implementation is discovered, and what "install an
extension" actually means for a Quarkus fast-jar image.

## 1. Installation is a rebuild, and only a rebuild

There is no runtime plugin mechanism. Karyo ships as one Quarkus fast-jar layout copied into an
image ([Building](../operations/building.md)), and CDI bean discovery happens at build-time
augmentation, so a JAR placed beside a running process is invisible
([ADR 0019](../architecture/decisions/0019-extensions-compile-into-the-build.md)).

The repository's own worked example says so at every layer. `services/karyo-app/build.gradle.kts:42`
comments the example module's inclusion as "Deliberate build-time augmentation, never a runtime JAR
upload", and gates it behind a Gradle property (`:43-45`):

```kotlin
if (providers.gradleProperty("karyoInventoryExample").map(String::toBooleanStrict).getOrElse(false)) {
    implementation(project(":services:inventory-service:karyo-inventory-ext-example"))
}
```

So `./gradlew :services:karyo-app:quarkusBuild -PkaryoInventoryExample=true` builds an image with the
example's beans in it, and the same command without the property builds one without them. The
[implementer guide](../guides/implementer-guide.md#extend-the-free-application) walks the executable
route, including the negative control that proves the unaugmented build does not have the extension.

Two SPI KDocs describe a looser idea. `LocationFilter.kt:21-22` says implementations are "Discovered
as CDI beans from any JAR on the classpath", and `StockSelectionFilter.kt:8` says "Deploy as
`@Alternative` `@Priority` in a client extension JAR". Both are true only of a JAR present at
augmentation; neither says so, and both sit directly beside the code an implementer is reading.

## 2. The example, and the two priorities

`services/inventory-service/karyo-inventory-ext-example/` is the canonical shape. Its build file
compiles against the API module and the CDI API with `compileOnly` and nothing else
(`services/inventory-service/karyo-inventory-ext-example/build.gradle.kts:6-8`), so an extension
cannot accidentally reach into a `-core`. It carries
`services/inventory-service/karyo-inventory-ext-example/src/main/resources/META-INF/beans.xml` with
`bean-discovery-mode="annotated"`.

`HeldLotStockFilter.kt:19-31` is the live example. It is annotated `@Alternative @Priority(1000)
@ApplicationScoped` and also overrides `priority() = 500`. Those two numbers do unrelated jobs, and
the codebase is careful about it: `@Priority` on an `@Alternative` is CDI's *activation* switch,
while `priority()` is the SPI's own *chain ordering*.

`HazmatStockFilter.kt:10-23` is the counter-example, kept deliberately: `@Alternative` with no
`@Priority`, so it is never activated even in the augmented build, and its own KDoc says so.

## 3. Selection is per-seam, and spelled four ways

There is no single "how do I win" rule. Reading the declarations:

| Seam | Declaration | Rule |
|---|---|---|
| `StockSelectionFilter` | `fun priority(): Int = 1000` | Every implementation runs, ascending; the chain's output order is honoured |
| `LocationFilter` | `fun priority(): Int = DEFAULT_PRIORITY` (1000) | Same, and the finder explicitly does **not** re-sort afterwards |
| `PackoutStrategy` | `val priority: Int` + `val name: String` | Named match first, then ascending priority until one returns non-null; built-in sits at a high value |
| `ReplenishmentStrategy` | `val priority: Int` + `val name: String` | Same shape |
| `CarrierAdapter` | `val priority: Int` + `fun handles(carrierName)` | Claim by carrier, then ascending priority |
| `WorkDispatchStrategy`, `SequenceNumberGenerator`, `CountScopeStrategy` | selected **by name** from configuration | An unknown name is a hard failure, never a silent fallback |
| `WebhookSigner`, `DeliveryRetryPolicy` | no priority member at all | Direct CDI injection; a replacement must win through CDI selection |

`LocationFilter`'s KDoc carries the strongest warning in the set: the finder honours the order the
filters return, and a maintainer must not add a post-filter sort, because a re-sort would silently
discard an extension's reordering (`LocationFilter.kt:12-19`). It is the only place such a warning is
written down beside the seam it protects.

The priority contract is therefore spelled four different ways across the seams, and nothing states
a rule for which one a new seam should use. The per-seam resolution rules are tabulated in
[Strategies and policies](../configuration/strategies-and-policies.md).

## 4. Seventy-seven seams in the registry, and no marker separating two kinds

Counting top-level `interface` declarations under any `*/spi/` package outside test and `spi/impl`
sources gives 79. Two are not extension points: `ReservationSourceState`, the opaque value
`ReservationRefMover` returns to its own caller, and `ConcurrentStateChange`, a marker an exception
carries. That leaves **77** declared seams across the `-api` modules plus `libs/karyo-sequence`.

`GET /api/v1/admin/extensions` (`AdminExtensionsResource.kt:41-69`, `ADMIN` only) is the live
registry: it resolves a list of fully-qualified interface names via `Class.forName` and asks the CDI
`BeanManager` which beans satisfy each. Its design is honest about its own limits - an interface that
fails to resolve is dropped rather than fabricated, and one that resolves with zero beans is still
reported, "because a declared seam with no active implementation is itself useful information"
(`AdminExtensionsResource.kt:28-40`).

The list (`AdminExtensionsResource.kt:92-189`) holds all 77, and its comment states the rule that
makes it checkable: one row per top-level interface in a `*.spi` package, with the two exclusions
above, and "any other absence is a defect in this list" (`:72-81`). Every `-api` module is on the
classpath of every build, so in a free installation the commercial engines' seams - cross-docking,
waves, streaming, monitors, forecasting, slotting and simulation - are listed with an empty
`implementations`, which is exactly what they are: declared, and not filled (`:88-91`).

**What the registry still does not do** is tell the two kinds of seam apart. Some of the 77 are
strategies an implementer may replace; many are in-process lookups and ports with one implementation
and no chain - every `*Lookup` and `*Port`, and `StockPicker`, `StockReceiver`, `StockReserver`,
`StockMover`, `UnitLoadMover`, `ReservationRefMover` and `OpenPickGuard`. Several of those say so
about themselves, `RuntimePropertyLookup.kt:14-15` most bluntly: "This is a cross-module read
contract, not a strategy seam: there is no plausible second implementation, and none should be
added." The package name is `spi` for both kinds, and there is no annotation, marker interface,
naming rule or response field that separates "you may implement this" from "this is an internal
seam". The registry's own comment acknowledges the gap (`AdminExtensionsResource.kt:83-86`). An
implementer is handed one list in which the safe answers and the ones that break on the next release
look identical.

## 5. A third list, in the front end

`frontend/web/src/pages/admin/spi-catalog.ts` is a static catalogue of 10 seams with an
`extensible: boolean` flag. Its header comment describes it as a curated, intentionally static list
standing in until the seams could be discovered at runtime (`spi-catalog.ts:12-15`).

Runtime discovery now exists: `AdminExtensionsResource` is it, and `use-extensions.ts:6-7` describes
itself as "The runtime counterpart of the static `SPI_CATALOG`". The static list survives in two
places:

- **As the fallback view.** `admin-strategies-page.tsx:53-57` renders the live registry when it
  answers and the static catalogue only when it is unavailable or empty, with the note "Showing
  bundled catalog (live registry unavailable)" (`:212`). The fallback view's three headline tiles -
  "Extension seams", "Open for a drop-in JAR" and "Modules" - are computed from `SPI_CATALOG`
  (`:191-201`).
- **As the navigation badge, unconditionally.** `admin-navigation.ts:72` is
  `badge: SPI_CATALOG.length`, so the administration menu says 10 beside a page whose live registry
  answers 77.

The always-rendered page subtitle tells every visitor to "drop it on the classpath to extend one"
(`admin-strategies-page.tsx:39`), and the `extensible` field's own KDoc reads "Whether third parties
can add implementations (drop-in JAR, or JSONB config)" (`spi-catalog.ts:26`). Both carry the
drop-in wording that §1 and `services/karyo-app/build.gradle.kts:42` contradict.

## 6. What an implementer is actually promised

An extension is recompiled and tested against each release it runs on. SPI versioning is
independent of the REST surface's `/api/v1` URL versioning - they move separately and nothing ties
them - and no SPI carries a version marker of its own. Additive members with defaults are the way a
seam grows without breaking existing implementations, but nothing guarantees that an extension
survives a release unchanged.

There is no published Maven coordinate to build against: no module applies a publishing plugin, and
an extension builds inside this repository's module graph, as the example does.

## Related

- [Strategies and runtime configuration](strategies-and-runtime-configuration.md) - the knobs a seam reads
- [Strategies and policies](../configuration/strategies-and-policies.md) - each seam's actual resolution contract
- [Implementer guide: extend the free application](../guides/implementer-guide.md#extend-the-free-application) - the executable installation route
- [ADR 0019](../architecture/decisions/0019-extensions-compile-into-the-build.md) - why extensions compile into the build
