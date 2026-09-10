# Frontend

The two front ends, how each routes, and where role and entitlement gating actually happen.

Derived from `frontend/web/src/routes/router.tsx`, `frontend/mobile/src/routes/router.tsx`, and the
licence and guard components.

## Two applications, one origin

React and TypeScript throughout ([ADR 0016](decisions/0016-two-frontends-same-origin.md)). The
desktop console is served at `/`, the floor PWA at `/m/`, both as static bundles from the nginx
container with SPA fallbacks. They share an origin with the API, so there is no CORS surface in
production.

They are separate applications, not one responsive build: separate `src` trees, separate route
tables, separate Vitest projects.

## Desktop routing

React Router v7, imported from `react-router` (`frontend/web/src/routes/router.tsx:1`), not
`react-router-dom`.

The whole tree sits under one `AuthGuard` using Keycloak `check-sso`. The router's own comment
records the tenancy consequence (`:41-43`): `AuthGuard` starts login for unauthenticated visitors
and returns to `/`, with no tenant or workspace picker, because tenancy is silo.

Two routes exist only as redirects: `/replenishment` and `/pick-orders` both `Navigate` to `/tasks`
with a `?type=` filter (`:79-96`), because replenishment and picking are task types in the unified
work view rather than pages of their own. The redirects keep bookmarks and printed links working.

## Role gating is admin-only, and split

Only `/admin/*` is role-gated. `AdminShell` itself carries no guard; the children are split into
two nested `AdminGuard`s (`:163-222`):

- `user-admin` gates strategies, health, audit, clients, documents, document-templates, properties
  and unit-load-types.
- `integration-admin` gates only `/admin/integrations`.

The split exists so a principal holding `integration-admin` but not `user-admin` - a `manager` -
can reach Integrations without being granted the broader role. The sidebar mirrors it through
`visibleAdminNavItems` (`frontend/web/src/config/admin-navigation.ts:93`), so that principal never
sees entries it would be redirected away from. The router comment states both halves. This is a
good pattern: the guard and the navigation are derived from the same permission split rather than
maintained separately.

Everything outside `/admin` is authenticated-only. Operational authority is enforced at the API,
not in the route table.

## Entitlement gating lives in the page, not the router

The router knows nothing about licensing. Every commercial feature has an ordinary route, and the
page component decides:

```
const license = useLicense();
if (license.isLoading) { ... }
else if (!license.isEntitled('monitors')) { <LockedMonitorsPanel /> }
```

All six commercial desktop pages do this consistently: waves, streaming, monitors, forecasting,
slotting, simulation. The document-templates admin page, the dashboard's exception card, the
Warehouse > Items analytics columns and the order-strategy form check the same way
([Gating and degradation](../commercial/gating-and-degradation.md#the-console-tells-the-truth-about-all-six-screens)).

The mechanism is `GET /api/v1/license`, which `frontend/web/src/features/license/license-api.ts:12-14`
documents as a "Gate-discovery endpoint - NOT gated by any entitlement itself, so the UI can always
ask 'what do I have?'". `useLicense` caches with `staleTime: Infinity`
(`frontend/web/src/features/license/use-license.ts:4-9`), which is correct given entitlements are
resolved once per application boot
([ADR 0021](decisions/0021-signed-entitlement-resolved-at-startup.md)).

Gating in the page rather than the router gives a locked feature a URL. Gating in the router would
produce a 404 or a redirect, and an operator following a link to a feature their company has not
bought would see nothing to explain it. Gating in the page produces an upsell panel at the address
they expected.

Not every commercial engine has a page. Cross-docking has no desktop route at all: it is triggered
by a receiving observer and surfaces as transport orders in `/tasks`, which is why
`frontend/web/src/pages/tasks/work-model.ts:17-21` carries a `CROSS_DOCK` task type and no
cross-dock page exists. Cartonization has no screen by construction - it changes how packout plans
boxes, and appears only as a padlock on the order-strategy form.

## Floor PWA

Fifteen routes, all under one auth guard, all task-shaped
(`frontend/mobile/src/routes/router.tsx:23-37`): the work inbox at `/`, `/pick/:ref`, `/move/:ref`,
`/count/:ref`, `/receive/:ref`, plus a menu, an inquiry screen, receipt selection, ad-hoc move and
count, pack, reprint, sort, packout and a `/sync-issues` screen.

`/sort` and `/packout` are wave-engine surfaces, so the floor app reaches commercial functionality.
**Known defect:** the floor app has no licence awareness. There is no licence check anywhere in
`frontend/mobile`, and its numbered menu gates on roles alone
(`frontend/mobile/src/menu/registry.ts:13-14`), so on an instance without the wave engine an
operator sees Sort and Pack-out, taps one, and meets an ordinary error banner rather than the
locked state the console shows. See
[Gating and degradation](../commercial/gating-and-degradation.md#the-floor-does-not).

## Known debt

Web lint is non-blocking in CI (`.github/workflows/ci.yml:81-84`), a known and accepted position.
Vitest's failure summary has to be read separately from lint output. The `configureVitest` worker
cap in `frontend/web/vitest.config.ts:20-40` exists because Vitest merges command-line options over
the config file, so a plain `maxWorkers` setting would not survive a `--maxWorkers` override.

## Related

- [Identity and tenancy](identity-and-tenancy.md) - what the token carries
- [Gating and degradation](../commercial/gating-and-degradation.md) - every locked screen
- [User guide: the desktop console](../user-guide/desktop-console.md) and
  [the floor app](../user-guide/floor-app.md) - the same two applications from a user's side
