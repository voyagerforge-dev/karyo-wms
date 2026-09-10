# ADR 0021: Entitlement is an Ed25519-signed token, resolved once at startup

**Status:** Accepted

## Context

A commercial engine can be present in an image and still not be paid for (ADR 0020). Something
inside the running application has to decide which of the engines present may run. It has to work
on a host the customer controls, with no service to call, it must not be defeated by editing
configuration, and the product must never need the vendor's signing secret to make the decision.

## Decision

- **A licence is a signed token:** a base64url JSON payload, a dot, and a base64url Ed25519
  signature computed over the payload substring itself. The payload carries `licenseId`,
  `customer`, `entitlements`, `issuedAt` and a nullable `expiresAt`. Unknown payload fields are
  ignored on purpose, so a vendor can mint claims that other tooling reads without changing any
  entitlement decision made here.
- **Verification needs only a public key.** It uses the JDK's own `Ed25519` providers, so the
  product carries no extra cryptographic dependency. The public key has one home, a resource file in
  `libs/karyo-license` that holds the key and nothing else, so every reader is a strip and no two
  readers have to agree on a format; `karyo.license.public-key` can override it. The private key
  and the minting tool are not in this repository.
- **`LicenseService` resolves the entitlement set once, when the application-scoped bean is
  constructed:**
  1. `karyo.license.key` set and verifying (good signature, not expired): the token's
     entitlements.
  2. `karyo.license.key` set and not verifying: the empty set. A present but invalid licence never
     falls back to anything weaker.
  3. No signed key: the unsigned `karyo.license.entitlements` list (`KARYO_LICENSE`), which the
     class documents as a development fallback.
- **Entitlements are global to the instance.** `isEntitled(moduleKey)` takes no goods owner. Under
  silo tenancy one instance serves one operating company and the licence belongs to that company
  (ADR 0014).
- **Each commercial engine checks its own entitlement at its entry points.** `require(key)` throws
  `LicenseRequiredException`, answered as HTTP 403 with a problem type of its own
  (`.../license-required`), where the engine adds a capability with no free equivalent;
  `isEntitled(key)` with an early return where the engine replaces a free behaviour, so the free
  behaviour runs instead.
- **The edition is a property of the image, not of the licence.** An image with no
  `LicensedModuleInstallation` bean is `community`; any other is `commercial`. `GET /api/v1/license`
  tells an anonymous caller only the edition, and an authenticated one the entitlements it holds
  that the image actually installs.

## Consequences

- No network call, no licence server and no vendor secret in the product. The gate is open
  source; only the signing key is secret.
- A licence cannot add an engine to an image that does not contain one. In the free build of this
  repository there is nothing for any entitlement to unlock.
- A missing or empty public-key file fails the boot and names the file, rather than silently
  locking every engine. Replacing the key is a one-line change to that file, after which every
  licence signed with the old key stops verifying at the next restart.
- **Known defect: a licence that expires while the application runs keeps working until the next
  restart.** The entitlement set is computed in a property initialiser and never recomputed, so
  expiry takes effect at whatever restart comes next, not at the moment it passes.
- **Known defect: nothing defines what happens to work in flight when a restart finds an
  entitlement gone.** A wave released while the instance was entitled is then finishable by no
  route. Every wave, sort and pack-out operation is refused, cancel included, and the free
  per-order packing route refuses the wave's orders because they are consolidated in a wave. Goods
  sit on a cart with live reservations and no supported way forward, and no message explains why.
  Cross-docking has the same shape in a milder form: its expiry sweep is gated, so rows past their
  staging deadline are neither disposed of nor cancellable. What a customer is owed for data an
  engine wrote before its entitlement lapsed has not been decided; the rows stay in the schema and
  the API that reads them answers 403.
- **Known defect: the unsigned list is honoured in every profile.** Nothing in the `%prod` profile
  switches the `karyo.license.entitlements` fallback off, so in an image that contains commercial
  engines, one environment line enables any of them with no signature, no expiry and no record of
  who did it. In this repository's free build it unlocks nothing, and the environment template says
  to keep `KARYO_LICENSE` empty.
- **Coverage is held by convention.** Every entry point of every commercial engine carries its own
  check; no annotation, interceptor, test or build rule fails when a new entry point forgets one.

## Alternatives considered

- **Checking the entitlement on every call, so that expiry takes effect when it passes.** Not
  built. The reason entitlements are resolved once rather than per call is not recorded.
- **An entitlement per goods owner.** Not built. Under silo tenancy the licence belongs to the
  company that owns the instance, so the instance-wide scope matches who holds the licence.
- **Unsigned configuration as the production mechanism.** Rejected: anyone holding the
  environment file could turn any engine on. The signed token is the mechanism; the unsigned list
  survives only as the development fallback described above.

## Evidence

- `libs/karyo-license/src/main/kotlin/com/karyo/license/LicenseVerifier.kt:11-31` - token format,
  ignored fields, the JDK's Ed25519 providers
- `LicenseVerifier.kt:39-61` - verification; expiry is checked at `:59`, once
- `libs/karyo-license/src/main/kotlin/com/karyo/license/LicenseService.kt:8-20` - the resolution
  order
- `LicenseService.kt:43-68` - resolved in a property initialiser, never again
- `LicenseService.kt:70-77` - `isEntitled` and `require` take no goods owner
- `libs/karyo-license/src/main/kotlin/com/karyo/license/VendorKey.kt:3-13,28-34,45-56` - one home
  for the public key, and a boot failure when it is missing
- `libs/karyo-license/src/main/kotlin/com/karyo/license/LicenseRequiredExceptionMapper.kt:10-25` -
  the 403 and its problem type
- `libs/karyo-license/src/main/kotlin/com/karyo/license/LicenseEdition.kt:3-23` and
  `libs/karyo-license/src/main/kotlin/com/karyo/license/LicenseResource.kt:27-45` - edition and
  disclosure
- `services/karyo-app/src/main/resources/application.yaml:164-169` - the unsigned fallback and its
  placeholder default
- `scripts/.env.prod.example:86-93` - the template keeps both licence variables empty
- `services/fulfillment-service/karyo-fulfillment-core/src/main/kotlin/com/karyo/fulfillment/service/PackingService.kt:82-88`
  and `.../fulfillment/service/ConsolidatedOrderGuard.kt:36-43` - the free packing route refusing
  a wave's orders
- [Licence and entitlement](../../operations/licence-and-entitlement.md)
- [Gating and degradation](../../commercial/gating-and-degradation.md)
- [The commercial boundary](../commercial-boundary.md)

## Related

- [ADR 0020](0020-free-and-commercial-boundary-per-module.md) - where the commercial boundary is
  drawn
- [ADR 0014](0014-silo-tenancy-and-goods-owners.md) - silo tenancy, which makes entitlements
  instance-wide
- [ADR 0017](0017-versioned-rest-api-and-error-contract.md) - the error contract a licence refusal
  uses
