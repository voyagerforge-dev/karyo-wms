# Licence and entitlement

Karyo is Apache-2.0. Ten optional engines are licensed separately and are not in this repository.
This document covers the mechanism that lets one build carry both halves: what a licence is, how
one reaches a running deployment, and what it does and does not do once it is there. What the gate
protects, and how a free installation meets it, is in
[the commercial boundary](../architecture/commercial-boundary.md) and
[gating and degradation](../commercial/gating-and-degradation.md).

Derived from `libs/karyo-license/src/main/kotlin/com/karyo/license/`,
`services/karyo-app/src/main/resources/application.yaml`, `scripts/.env.prod.example` and
`scripts/render_compose_env.py`.

## What a licence is

A base64url payload, a dot, and a base64url Ed25519 signature over the UTF-8 bytes of the payload
substring - "the exact substring before the dot, not the decoded JSON"
(`libs/karyo-license/src/main/kotlin/com/karyo/license/LicenseVerifier.kt:16-18`). The payload
carries `licenseId`, `customer`, `entitlements`, `issuedAt` and a nullable `expiresAt`
(`LicenseVerifier.kt:20-21`).

Verification uses JDK 21's native `Ed25519` `KeyFactory` and `Signature` providers, so the product
carries no extra cryptography dependency (`LicenseVerifier.kt:29-30`). `verify` returns null for any
malformed, badly signed or expired token and never throws (`LicenseVerifier.kt:35-61`).

**Unknown payload fields are ignored deliberately.** The vendor may mint additional claims that
other tooling reads - an optional `customerId` naming the goods owner is one - and the runtime gate
has no use for them. The KDoc says not to tighten parsing to reject unknown fields, because that
would break those consumers while changing no entitlement decision made here
(`LicenseVerifier.kt:23-27`).

`issuedAt` is parsed and never checked. Only `expiresAt` gates (`LicenseVerifier.kt:59`).

Minting a licence, and the private key that signs one, are not in this repository.

## The vendor key has one declared home

`libs/karyo-license/src/main/resources/com/karyo/license/vendor-public-key.txt` holds the public
key alone - one line, no comments, no blank lines. Its reader does nothing but read and strip, and
the format is kept that plain on purpose: any richer format would be a parsing rule every reader
of the file has to keep agreeing on (`VendorKey.kt:45-56`). A missing, unreadable or empty
resource throws at class initialisation, which surfaces as a boot failure naming the file rather
than as every licensed engine silently locking (`VendorKey.kt:28-34`).

Changing the key is a one-line replacement of that file and nothing else in code. Every licence
signed under the old key stops verifying the moment the new one ships. The key pair is generated
with `LicenseKeygenTest` (`VendorKey.kt:11-12`).

`karyo.license.public-key` overrides the bundled key for one deployment; its default is the
sentinel `bundled`, which resolves to the file (`VendorKey.kt:18-26,42-43`).

## How a licence reaches a deployment

`LicenseService` reads three configuration properties, resolved **once, at construction**
(`libs/karyo-license/src/main/kotlin/com/karyo/license/LicenseService.kt:21-43`):

| Property | Environment spelling | Meaning |
|---|---|---|
| `karyo.license.key` | `KARYO_LICENSE_KEY` | the signed token |
| `karyo.license.public-key` | `KARYO_LICENSE_PUBLIC_KEY` | override for the bundled vendor key |
| `karyo.license.entitlements` | `KARYO_LICENSE` | an unsigned comma-separated list |

Each carries a non-empty placeholder default (`none`, or `bundled`) because SmallRye Config treats
an empty resolved value as missing and fails boot with `SRCFG00040` once any bean injects the
service. The sentinels are filtered back out, so the effective default stays empty
(`LicenseService.kt:23-37`, `application.yaml:164-169`). The same rule appears against a dozen
unrelated properties in `application.yaml`; it is a repository-wide convention rather than a
licensing quirk.

Resolution order, stated in the KDoc and matching the code (`LicenseService.kt:8-20,45-67`):

1. `karyo.license.key` set, and it verifies: the token's entitlements.
2. `karyo.license.key` set, and it does **not** verify: nothing. A present but invalid licence is
   never silently downgraded to the unsigned list.
3. No signed key: the unsigned `KARYO_LICENSE` list.

The environment file reaches the application container through `scripts/render_compose_env.py`,
whose application bucket is everything that is not `KC_`, not `POSTGRES_`, and not
`KARYO_PUBLIC_ORIGIN` or `KEYCLOAK_URL` (`render_compose_env.py:40-46`), so both licensing
variables travel there and nowhere else.

The production template sets `KARYO_LICENSE=` empty and leaves `KARYO_LICENSE_KEY` commented out,
saying that a build of this repository contains no commercial engine, that entitlements cannot add
absent code, and that a signed token applies only to images that contain commercial engines
(`scripts/.env.prod.example:86-93`).

## What expiry does not do

`LicenseService` is `@ApplicationScoped` and computes its entitlement set in a property initialiser
(`LicenseService.kt:21,43`), so the set is fixed for the lifetime of the process
([ADR 0021](../architecture/decisions/0021-signed-entitlement-resolved-at-startup.md)).

**Known defect.** An `expiresAt` that passes at 03:00 changes nothing until someone restarts the
application: every entitled engine keeps working. A restart after expiry then locks all of them at
once, including any work an engine had in flight - what that does to, for example, a released wave
is in [gating and degradation](../commercial/gating-and-degradation.md). Nothing in the product
treats "entitled yesterday, not today" as a state it must handle.

## The unsigned list

`LicenseService`'s KDoc describes `KARYO_LICENSE` as "kept only as a dev fallback when no signed
license is configured" (`LicenseService.kt:9-12`). Nothing in the `%prod` profile disables it
(`application.yaml:315-343`), and the deploy script's validator does not mention it.

In an image built from this repository alone it unlocks nothing, because no engine is installed.
**Known defect.** In an image that carries commercial engines, anyone holding the image and its
environment file can enable any of them with one unsigned comma-separated line - no signature, no
expiry, no customer, no audit trail. The production template now tells the operator to keep it
empty; the code path is unchanged.

## Edition, and what a licence cannot do

`LicenseEdition` derives the edition from the `LicensedModuleInstallation` beans present in the
build, not from licence state: a build carrying no commercial engine is `community`, any other is
`commercial` (`LicenseEdition.kt:3-22`). The KDoc gives the reason - an entitlement list can only
ever be a subset of what the build installs, so the discriminator stays the same whether or not a
deployment carries a licence.

`LicenseResource` exposes that at `GET /api/v1/license` under `@PermitAll`. An anonymous caller
learns only the edition; an authenticated one gets the entitlement list intersected with what is
installed, so no commercial inventory can be reconstructed anonymously
(`LicenseResource.kt:27-45`).

The consequence for delivery: **a licence cannot add a missing engine.** A build of this
repository alone contains none, so a free installation has nothing for an entitlement to unlock,
and running a commercial engine means running an image that contains it - not applying a key to a
clone of this repository.

## Where the boundary is stated

`NOTICE` names the nine commercial modules as outside the Apache grant, licensed separately, and
absent from a build of this repository alone (`NOTICE:9-25`). The root build's per-module licence
packaging is what makes one build span both halves: every module here takes the root Apache-2.0
`LICENSE`, and a commercial `-core`, when a commercial checkout is overlaid, carries its own marker
in its own project directory, which is what its jar packages (`build.gradle.kts:66-72,84`; see
[building](building.md#licence-notices-packaged-and-verified)). An application image built with the
commercial engines also carries each one's marker under `/app/commercial-licenses/`, and a licence
label that names the commercial terms
([container images](container-images.md#licence-labels)). The boundary is per Gradle module
([ADR 0020](../architecture/decisions/0020-free-and-commercial-boundary-per-module.md)).

## Related

- [The commercial boundary](../architecture/commercial-boundary.md) - what is free, what is not,
  and how the build overlays the engines
- [Gating and degradation](../commercial/gating-and-degradation.md) - what each gate does when an
  entitlement is absent
- [What the commercial engines are](../commercial/README.md)
- [Deploying](deploying.md) - the environment file these variables live in
