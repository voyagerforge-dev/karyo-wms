# ADR 0016: Two front ends, served from the API's own origin - the console at `/`, the floor PWA at `/m/`

**Status:** Accepted

## Context

Karyo has two audiences with little in common at the screen. Office staff - planners,
supervisors, administrators - work at desks with large screens: configuring the warehouse, managing
orders, reading reports. Floor operators work on phones and enterprise scanners, usually one-handed
while holding goods, driven by scans rather than typing, over wireless coverage that drops out
between racks.

Both call the same REST API ([ADR 0017](0017-versioned-rest-api-and-error-contract.md)). Floor devices
need updates without an app-store cycle, and the enterprise scanners in use run Chrome-based browsers
that accept a hardware scan as keyboard input.

## Decision

- **Two separate single-page applications**, both React and TypeScript, built with Vite: the desktop
  console in `frontend/web` and the floor progressive web app in `frontend/mobile`. They have separate
  source trees, route tables and test projects; they are not one responsive build.
- **One nginx container serves both, the API and Keycloak from a single origin:** the console at `/`,
  the floor app at `/m/` (built with `base: '/m/'`), each with a fallback to its own `index.html`;
  `/api/` proxied to the application; `/auth/` proxied to Keycloak. `/api/internal/` is refused.
- **Both sign in through the same public client**, `karyo-web` ([ADR 0013](0013-keycloak-oidc.md)).
- **The floor app queues selected operations offline.** Pick confirmation, transport start and
  completion, count submission, "location empty" and release are queued in IndexedDB when the device
  is offline and replayed in order when it reconnects; a sync-issues screen shows any that failed.
  Every other floor operation needs the network.
- **The console gates only administration by role.** `/admin/*` is guarded by `user-admin`, with
  integrations separately under `integration-admin`; everything else requires only authentication, and
  operational authority is enforced by the API. Commercial features are gated in the page, not the
  router, so a locked feature still has an address and shows why it is locked
  ([ADR 0020](0020-free-and-commercial-boundary-per-module.md)).

## Consequences

- There is no cross-origin request in the shipped topology, so no CORS configuration exists and none is
  needed, and there is one place to terminate TLS.
- One language and one framework across both applications and the browser tests.
- Deploying a new image updates every floor device on its next load.
- A browser client served from any other origin cannot call the API: no CORS headers are sent.
- Two applications have to be kept in step: dependency versions, the Keycloak adapter, the API client.
- Offline working is partial by design. Only the queued operations survive a dropout.
- **Known defect.** The floor app has no licence awareness. Sort and Pack-out, which need a commercial
  engine, are on the menu of every installation. On a free one an operator who opens them gets no
  locked state, only the licence refusal text the API returns, shown as an ordinary error
  (`frontend/mobile/src/screens/packout-screen.tsx:9-10`).
- The console ships every commercial screen. A free installation shows them locked, by design of the
  page-level gate.

## Alternatives considered

- **Native floor applications, or React Native or Flutter.** Rejected. Native apps mean two codebases
  and an app-store release cycle; React Native or Flutter mean a second rendering framework or a third
  language beside Kotlin and TypeScript. The floor interface is forms, lists and scanning, which do not
  need native performance, and keyboard-wedge scanners work in a browser.
- **Vue, Angular or Svelte for the console.** Rejected for React's larger component ecosystem and
  contributor pool; Angular additionally for its weight and learning curve for developers who mostly
  work in Kotlin.
- **Server-side rendering (Next.js).** Rejected. An authenticated internal application gains nothing
  from server rendering and would need a Node server in the stack.
- **An API gateway product or a mobile backend-for-frontend in front of the application.** Rejected.
  Their purpose is routing to many services and aggregating their responses; with one application
  behind nginx, both clients call the same `/api/v1` routes directly.
- **One responsive application for both audiences.** Not recorded as considered.

## Evidence

- `infrastructure/docker/nginx/nginx.conf:123-127,141,174-183` - `/api/internal/` refused, `/api/` and `/auth/` proxied, `/m/` and `/` served with their fallbacks
- `infrastructure/docker/Dockerfile.nginx:31,37` - both builds copied into one image, the floor app under `m/`
- `frontend/mobile/vite.config.ts:8` - the floor app's `/m/` base
- `frontend/web/package.json:29-32` and `frontend/mobile/package.json:19-21,43` - React, React Router and the PWA plugin
- `frontend/mobile/src/lib/offline/op-queue.ts:1-17` - the operations that may be queued, and the IndexedDB store
- `frontend/mobile/src/lib/work-api.ts:48-51` - an operation queued when offline instead of failing
- `frontend/mobile/src/routes/router.tsx:21-37` - the floor app's routes, including `/sync-issues`
- `frontend/web/src/routes/router.tsx:41-50` - every console route under one authentication guard
- `frontend/web/src/features/license/use-license.ts:9` - entitlements read once and cached for the session
- `frontend/mobile/src/menu/registry.ts:13-14` - Sort and Pack-out on the floor menu unconditionally

## Related

- [ADR 0013](0013-keycloak-oidc.md) - the shared public client
- [ADR 0017](0017-versioned-rest-api-and-error-contract.md) - the API both front ends call
- [ADR 0020](0020-free-and-commercial-boundary-per-module.md) - what a locked commercial feature is
- [ADR 0022](0022-compose-four-container-deployment.md) - the nginx container in the stack
- [Frontend](../frontend.md) - routing, guards and entitlement gating in detail
- [User guide](../../user-guide/README.md) - both applications from the user's side
