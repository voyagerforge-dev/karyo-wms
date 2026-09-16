# Deploying Karyo

One script, one Compose file, four containers, one host. This document is both the runbook -
every command an operator types to install and maintain an installation - and a description of
what the deploy script does and why.

Derived from `scripts/deploy-server.sh`, `infrastructure/docker/docker-compose.prod.yml`,
`infrastructure/docker/docker-compose.maintenance.yml`, `scripts/.env.prod.example`,
`scripts/render_compose_env.py`, `scripts/validate_public_origin.py`,
`scripts/validate_credential.py` and `scripts/migrate_keycloak_realm.py`.

`scripts/deploy-server.sh` is 865 lines and is the whole installation mechanism. There is no
installer, no configuration management and no orchestrator: Compose on one host is the supported
deployment ([ADR 0022](../architecture/decisions/0022-compose-four-container-deployment.md)).

Messages printed by the deploy script, the environment templates and the realm migration tool
that point at a deployment guide by file name mean this document.

## What has to be on the host

- **Java 21 or newer, as a JDK.** `javac` must be available; a JRE fails. The script honours
  `JAVA_HOME` first (`deploy-server.sh:572-578`).
- **Node.js 24.x**, the single supported line, declared once in `.nvmrc` and enforced by both
  operator scripts through `scripts/lib/node-runtime.sh`. It is needed for the frontend builds
  and for `--validate-env`, which uses Node's WHATWG URL parser to validate the public origin.
- **Python 3**, for environment validation and rendering.
- **Docker with the Compose plugin**, or **Podman with `podman-compose`**.
- **Git.**
- **`cloudflared`**, only if the stack is exposed through a Cloudflare Tunnel (see
  [Public access](#public-access)). Its absence is a warning, not a failure
  (`deploy-server.sh:537-538`).

Stage 1 of the script checks all of these and reports what is missing
(`deploy-server.sh:530-586`).

The list is required even when nothing is being built. `--quick` skips Stages 2-4, but Stage 1
runs first regardless (`deploy-server.sh:509-511,592-596`), so a host that only starts images
built elsewhere still needs a JDK and a Node toolchain.

### One Node line, declared once

`.nvmrc` at the repository root declares the one supported Node.js major (`24`). nvm reads it
directly, CI's `setup-node` consumes it through `node-version-file: .nvmrc`, and both operator
scripts source `scripts/lib/node-runtime.sh`, which accepts exactly that major and fails closed on
a missing node, an unreadable version and a missing or malformed declaration. The deploy
preflight runs it in Stage 1 and on the `--validate-env` path; `scripts/run-e2e.sh` runs it before
resolving the E2E target. npm only warns on an engine mismatch, so the package manifests mirror
the line as `engines.node: ^24.0.0` with `engine-strict=true` (`.npmrc`), and the nginx image's
builder stages use `node:24-alpine` (`infrastructure/docker/Dockerfile.nginx:1,9`);
`tests/e2e/fixtures/node-runtime-preflight.test.ts` keeps every mirror equal to `.nvmrc`.

### The Java check does not do what its message says

`deploy-server.sh:581` parses the version with

```
JAVA_VERSION=$(java -version 2>&1 | head -1 | sed 's/.*"\([0-9]*\)\..*/\1/')
```

which requires a dot after the digits. A `.0` GA build prints `openjdk version "21" 2023-09-19`
with no dot, the substitution does not match, and `JAVA_VERSION` becomes the whole line.
`[ "$JAVA_VERSION" -lt 21 ]` then fails with "integer expression expected" and returns 2, which
the enclosing `if` reads as false. **Known defect.** The guard is skipped, and on a Java 17 GA
build the script prints `Java version openjdk version "17" 2021-09-14 meets minimum (21)`
(`deploy-server.sh:580-586`).

## Quick start

```bash
# 1. Clone the repository
git clone https://github.com/voyagerforge-dev/karyo-wms.git
cd karyo-wms

# 2. Create the environment file from its template, private from the start
install -m 0600 scripts/.env.prod.example scripts/.env.prod

# 3. Edit scripts/.env.prod: replace every CHANGE_ME value and set the deployment URLs.
#    KARYO_PUBLIC_ORIGIN is the exact browser origin, for example https://wms.example.com

# 4. Check the file without building or starting anything
./scripts/deploy-server.sh --validate-env scripts/.env.prod

# 5. Build and deploy
./scripts/deploy-server.sh

# 6. Open the application
#    Local:  http://localhost        (or http://localhost:<NGINX_HTTP_PORT>)
#    Public: https://<your-domain>   (see Public access)
```

The production realm imports no human users and no passwords. The first application
administrator is created after the first deployment from externally supplied Keycloak bootstrap
credentials; see [Provisioning the first administrator](#provisioning-the-first-administrator).
The development realm, `infrastructure/keycloak/karyo-realm.json`, carries fixed demo users and
is for local development only.

Use an isolated target and synthetic data first, and verify receiving, putaway, picking and
shipping before any real stock moves. The [implementer guide](../guides/implementer-guide.md)
walks through that.

## The environment file

The deploy script reads one file, `scripts/.env.prod`. It is created mode 0600 from
`scripts/.env.prod.example` if absent, and the mode is re-enforced on every run
(`deploy-server.sh:256-265,692-698`). Edit only this file; every deploy regenerates the
per-service files derived from it (see
[Rendering least-privilege container environments](#rendering-least-privilege-container-environments)).

`scripts/.env.prod.cloud-example` is the same shape, with resource limits sized for a 24 GB,
four-core ARM64 host.

### Required variables

| Variable | Purpose |
|---|---|
| `DB_USERNAME` | PostgreSQL role used by Karyo; must equal `POSTGRES_USER` and `KC_DB_USERNAME` |
| `DB_PASSWORD` | Shared PostgreSQL role password, at least 16 characters; must equal `POSTGRES_PASSWORD` and `KC_DB_PASSWORD` |
| `POSTGRES_USER` | The PostgreSQL role the container provisions; the same role |
| `POSTGRES_PASSWORD` | The password used when provisioning that role; the same password |
| `KC_DB_USERNAME` | Keycloak's database role; the same role |
| `KC_DB_PASSWORD` | Keycloak's database password; the same password |
| `KC_BOOTSTRAP_ADMIN_USERNAME` | Externally chosen Keycloak bootstrap-administrator username. Required only for a fresh Keycloak database or `--reset-db`; remove it once the bootstrap account is retired |
| `KC_BOOTSTRAP_ADMIN_PASSWORD` | Externally generated bootstrap password, at least 16 characters, not a dictionary, predictable, repeated or username-derived value. Same lifetime as the username |
| `KEYCLOAK_ADMIN_CLIENT_SECRET` | Secret for the permanent `karyo-admin` service account, at least 32 characters and distinct from every other secret |
| `OIDC_SECRET` | Secret substituted into the `karyo-backend` confidential client at realm import, at least 32 characters and distinct |
| `KARYO_PUBLIC_ORIGIN` | Exact browser-canonical origin: lowercase ASCII or punycode host, no default port, path, trailing slash, credentials or wildcard (for example `https://wms.example.com`) |
| `KARYO_DOMAIN` | The hostname portion of `KARYO_PUBLIC_ORIGIN` |
| `KC_HOSTNAME` | Keycloak's public URL including the `/auth` path (for example `https://wms.example.com/auth`) |

The origin must match the browser's `URL.origin` serialisation, including the omission of the
default port - 80 for HTTP, 443 for HTTPS. The production realm permits exactly four callbacks beneath it,
and none may be relaxed into a wildcard:

```
/                          desktop callback
/silent-check-sso.html     desktop silent single sign-on
/m/                        floor callback
/m/silent-check-sso.html   floor silent single sign-on
```

### What the validator refuses

`validate_env` (`deploy-server.sh:268-467`) is the substantial part of the script, and the only
thing between an operator and a stack that starts with the wrong credentials:

- **Syntax.** Every non-comment line must be `NAME=value` with no `export` and no whitespace
  around the name or the equals sign, and the offending line number is named
  (`deploy-server.sh:296-305`).
- **Exactly once.** A required variable assigned twice is refused, because the last assignment
  silently wins (`deploy-server.sh:308-319`).
- **Literal values.** A value containing whitespace, a quote, a `#`, a `$` or a backslash is
  refused, so nothing in the file depends on shell interpolation the readers do not perform
  (`deploy-server.sh:321-331`).
- **Placeholders.** `CHANGE_ME`, `karyo.example.com` and the literal `dev-backend-secret` are
  each named individually (`deploy-server.sh:332-342`).
- **Consistency.** `DB_USERNAME`, `POSTGRES_USER` and `KC_DB_USERNAME` must name the same role,
  and the three password variables must carry the same value, because one PostgreSQL role serves
  both Karyo and Keycloak (`deploy-server.sh:409-416`).
- **Strength**, through `scripts/validate_credential.py`: 16 characters for the database and
  bootstrap passwords, 32 for `KEYCLOAK_ADMIN_CLIENT_SECRET` and `OIDC_SECRET`, and rejection of
  dictionary, predictable, repeated and username-derived values. Existing role passwords are not
  grandfathered (`deploy-server.sh:417-433`).
- **Distinctness.** The admin client secret must differ from the bootstrap password and the OIDC
  secret; the OIDC secret must differ from the bootstrap password (`deploy-server.sh:434-440`).
- **URLs**, through `scripts/validate_public_origin.py`, which shells out to Node's WHATWG `URL`
  parser so that the accepted origin is the one a browser would compute
  (`validate_public_origin.py:11-28`). Its exit code 3 is distinct from 2 so that a missing Node
  is reported as a missing tool rather than filed under the operator's configuration
  (`validate_public_origin.py:36-43`, `deploy-server.sh:441-455`).
- **The maintenance port.** `KARYO_KEYCLOAK_MAINTENANCE_PORT` must be an integer from 1 through
  65535 and may be assigned at most once (`deploy-server.sh:393-407`).

The whole validator is reachable on its own with `--validate-env FILE`, which exits before
anything is built or started (`deploy-server.sh:502-507`). Success validates the values in the
file. It proves nothing about the target host, or about the password a persisted database role
actually holds.

`KEYCLOAK_URL` is optional and defaults to `/auth` for validation only - the default is never
written back (`deploy-server.sh:385-392`). **Known defect.** If an operator removes the line, the
rendered nginx environment file is empty (`render_compose_env.py:47`), `envsubst` replaces the
unset variable with an empty string, and the entrypoint's guard - which looks for an
unsubstituted `${KEYCLOAK_URL}` token - has nothing to find
(`infrastructure/docker/nginx/docker-entrypoint.sh:7-22`). nginx starts healthy, Stage 8's SPA
probe sees `/` return 200 (`deploy-server.sh:832-838`), the deploy reports success, and both
front ends ship with an empty Keycloak base URL, so nobody can sign in. Keep `KEYCLOAK_URL=/auth`.

### Optional variables

| Variable | Default | Purpose |
|---|---|---|
| `DB_URL` | `jdbc:postgresql://postgresql:5432/karyo` | JDBC connection URL |
| `OIDC_URL` | `http://keycloak:8080/auth/realms/karyo` | Keycloak OIDC endpoint on the container network |
| `KEYCLOAK_ADMIN_URL` | `http://keycloak:8080/auth` | Keycloak Admin API used for user management |
| `KEYCLOAK_URL` | `/auth` | Keycloak base URL the front ends use; relative is preferred, and an absolute one must use `KARYO_PUBLIC_ORIGIN` exactly |
| `NGINX_HTTP_PORT` | `80` | Host port nginx binds. Set a high port, for example `8088`, for rootless Podman that cannot bind 80 |
| `KARYO_KEYCLOAK_MAINTENANCE_PORT` | `8181` | Loopback-only Keycloak port, published only while `docker-compose.maintenance.yml` is layered on for a maintenance window |

Application settings that are also environment variables - the scheduled jobs, the AI provider,
the demo engine, the over-receipt stop, the stock reaper - are described in
[Operating an installation](operating-an-installation.md).

### Resource limits

Resource limits are optional. Leave them commented out unless the host needs tuning, and tune
only after observing the complete stack under representative load.

| Variable | Default | Example for a larger host | Controls |
|---|---|---|---|
| `APP_MEM_LIMIT` | `1536m` | `4g` | `karyo-app` container memory (`docker-compose.prod.yml:86-87`) |
| `JAVA_OPTS` | `-Xms128m -Xmx1024m ...` | `-Xms256m -Xmx3g ...` | JVM flags inside the application container (`infrastructure/docker/Dockerfile.service:72-73`) |
| `GRADLE_OPTS` | `-Xmx512m -XX:MaxMetaspaceSize=256m` | `-Xmx2g -XX:MaxMetaspaceSize=512m` | Gradle heap for the Stage 2 build (`deploy-server.sh:600-601`) |

`APP_MEM_LIMIT` reaches Compose through the shell rather than an `env_file`, so the script reads
it from `scripts/.env.prod` and exports it before starting containers
(`deploy-server.sh:705-712`).

`GRADLE_OPTS` is read from the **invoking shell** at Stage 2, before the environment file is read
at Stage 5 (`deploy-server.sh:601,690-701`). Export it before running the script. **Known
defect.** Both environment templates and the script's own comment present `GRADLE_OPTS` as an
environment-file setting (`scripts/.env.prod.example:77`, `scripts/.env.prod.cloud-example:54`),
and a value set only there never reaches the build.

### Rendering least-privilege container environments

`scripts/render_compose_env.py` splits the one source file into four - `.env.prod.postgresql`,
`.env.prod.keycloak`, `.env.prod.app` and `.env.prod.nginx` - each created with `O_EXCL` at mode
0600 before any secret is written, and moved into place atomically
(`render_compose_env.py:51-69`). The production Compose file mounts each as that service's
`env_file` (`docker-compose.prod.yml:9,33,83,111`), so database and bootstrap credentials never
enter the nginx or application containers.

The split is the whole containment story, so it is worth stating exactly
(`render_compose_env.py:26-48`):

| File | Contents |
|---|---|
| `.postgresql` | everything beginning `POSTGRES_` |
| `.keycloak` | everything beginning `KC_`, plus `KARYO_PUBLIC_ORIGIN`, `KEYCLOAK_ADMIN_CLIENT_SECRET` and `OIDC_SECRET` |
| `.app` | everything that is not `KC_`, not `POSTGRES_`, and not `KARYO_PUBLIC_ORIGIN` or `KEYCLOAK_URL` |
| `.nginx` | `KEYCLOAK_URL` and nothing else |

All four are gitignored by name (`.gitignore:45-50`) and excluded from every image build context
(`.dockerignore:18`).

## Provisioning the first administrator

Keycloak creates its bootstrap administrator from `KC_BOOTSTRAP_ADMIN_USERNAME` and
`KC_BOOTSTRAP_ADMIN_PASSWORD` only when its database is fresh. Whether it is fresh is decided by
the database, not by a flag: after PostgreSQL is healthy the script queries Keycloak's own schema
for a `master` realm row (`deploy-server.sh:203-226`). On a fresh database the deploy refuses to
start Keycloak unless both values are supplied; on an initialised one it warns that they are inert
and should be removed (`deploy-server.sh:761-776`). The production realm import defines no
application users (`deploy-server.sh:855`).

After the first deployment:

1. Open `<KARYO_PUBLIC_ORIGIN>/auth/admin/` and sign in to the **master** realm with the
   bootstrap username and password.
2. Select the **karyo** realm, open **Users**, and create the first application administrator.
3. Set the user attributes `client_id=0`, `principal_kind=ops`, `tenant_code=SYS`, and the
   deployment's warehouse identifier (for example `warehouse_id=WH-001`). What each attribute
   means is in [identity and tenancy](../architecture/identity-and-tenancy.md).
4. On **Credentials**, set an independently generated strong temporary password, leave
   **Temporary** on, and deliver it through a secure channel.
5. On **Role mapping**, assign the `ADMIN` realm role.
6. In a separate browser session, sign in to Karyo with the new account and complete the
   mandatory password change. Sign out, prove the temporary password no longer works, then sign
   back in with the replacement.
7. Return to the **master** realm and delete the temporary bootstrap user. Verify that its
   credentials no longer authenticate, then remove both bootstrap assignments without creating
   another secret-bearing file:

   ```bash
   python3 - <<'PY'
   import os
   from pathlib import Path

   path = Path("scripts/.env.prod")
   retired = {"KC_BOOTSTRAP_ADMIN_USERNAME", "KC_BOOTSTRAP_ADMIN_PASSWORD"}
   with path.open("r+", encoding="utf-8") as env_file:
       lines = env_file.readlines()
       env_file.seek(0)
       env_file.writelines(
           line for line in lines if line.partition("=")[0] not in retired
       )
       env_file.truncate()
   os.chmod(path, 0o600)
   PY
   ./scripts/deploy-server.sh --validate-env scripts/.env.prod
   python3 scripts/render_compose_env.py scripts/.env.prod >/dev/null
   ```

8. In Karyo, create a test user on the **Users** page and explicitly select an active goods owner
   such as `ACME`. Sign in as that user and verify that its work is attributed to that owner, then
   deactivate and reactivate it. A goods-owner administrator can select only their own owner; an
   operations administrator can manage users across the owners visible on that page.

Karyo's user management uses the separate `karyo-admin` confidential client, whose service
account holds only `manage-users` and `view-realm` in the `karyo` realm. Login auditing uses the
`karyo-backend` client with `view-events` and `view-users`. Neither service identity has
master-realm administrator access. Rotate `KEYCLOAK_ADMIN_CLIENT_SECRET` by changing the
`karyo-admin` client secret in Keycloak and the environment value together.

Do not keep a master-realm administrator for later maintenance; use the isolated procedure in
[Changing an existing Keycloak realm](#changing-an-existing-keycloak-realm), with every
application, reverse-proxy and ordinary Keycloak route stopped until the temporary administrator
is retired.

Changing the bootstrap variables does not reset an account in an existing Keycloak database. A
`--reset-db` deployment destroys Keycloak state and needs newly generated one-time bootstrap
credentials, so repeat the first-user, password, deletion and clean-up steps after every reset.

## Rotating the PostgreSQL role password

PostgreSQL applies `POSTGRES_PASSWORD` only while initialising a fresh data directory. Changing
`DB_PASSWORD`, `POSTGRES_PASSWORD` and `KC_DB_PASSWORD` in `scripts/.env.prod` does not update the
persisted role, and the deploy script does not run `ALTER ROLE` for you. It does make the
mismatch loud: `verify_postgres_role_password` runs after PostgreSQL is up and **before** Keycloak
or the application start, and halts with a message saying the environment was updated but the
live role was not rotated (`deploy-server.sh:228-248`). A password that fails the credential
policy is rejected before any container starts.

To rotate the live password:

1. Keep the current working password in `scripts/.env.prod` so you can still authenticate.
2. Generate a new password that satisfies the credential policy: at least 16 characters, and not
   a dictionary, predictable, repeated or username-derived value.
3. Read both values at hidden prompts and validate the exact candidate before changing the role.
   Substitute the actual `POSTGRES_USER` value if it is not `karyo`:

   ```bash
   DB_ROLE=karyo
   read -rsp 'Current PostgreSQL role password: ' PGPASSWORD
   echo
   read -rsp 'New PostgreSQL role password: ' ROTATED_DB_PASSWORD
   echo
   export PGPASSWORD ROTATED_DB_PASSWORD
   printf '%s' "$ROTATED_DB_PASSWORD" |
     python3 scripts/validate_credential.py --min-length 16 --username "$DB_ROLE" --env-literal
   ```

4. Apply that validated value through a quoted `psql` stdin program. The two exported values are
   passed to the container by name, so neither password appears in process arguments, the SQL
   program or shell history:

   ```bash
   # Keep COMPOSE_PROJECT_NAME set to the selected deployment.
   POSTGRES_CONTAINER=$(docker ps -q \
     --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME:-karyo-prod}" \
     --filter "label=com.docker.compose.service=postgresql")
   test -n "$POSTGRES_CONTAINER" || { echo 'No PostgreSQL container in the selected project'; exit 1; }
   docker exec -i --env PGPASSWORD --env ROTATED_DB_PASSWORD "$POSTGRES_CONTAINER" \
     psql -h 127.0.0.1 -U "$DB_ROLE" -d postgres -v ON_ERROR_STOP=1 <<'SQL'
   \getenv rotated_password ROTATED_DB_PASSWORD
   SELECT format('ALTER ROLE %I WITH PASSWORD %L', current_user, :'rotated_password') \gexec
   SQL
   ROTATION_STATUS=$?
   unset PGPASSWORD ROTATED_DB_PASSWORD
   test "$ROTATION_STATUS" -eq 0
   ```

   Use `podman` in place of `docker` when that is the runtime; both accept an environment
   variable name without its value.
5. Set all three environment values in `scripts/.env.prod` to the new password: `DB_PASSWORD`,
   `POSTGRES_PASSWORD` and `KC_DB_PASSWORD`.
6. Restart Keycloak and the application **together** with `./scripts/deploy-server.sh --quick`
   (or a full deploy), so both authenticate with the rotated role. Do not restart only one of
   them.
7. Confirm `/q/health/ready` and `/auth/realms/karyo` succeed.

If the three environment values are updated before the `ALTER ROLE`, the next deploy stops after
PostgreSQL is up and names this procedure. Run the `ALTER ROLE` with the new password, then deploy
again. There is no supported path that leaves Keycloak or the application running against a
password the live role does not have.

`OIDC_SECRET` and `KEYCLOAK_ADMIN_CLIENT_SECRET` are rotated through the realm procedure below.

## Changing an existing Keycloak realm

Keycloak imports `infrastructure/keycloak/karyo-realm-prod.json` only when the `karyo` realm does
not exist yet: `start --import-realm` skips a realm that is already in the database
(`docker-compose.prod.yml:32`). Editing the realm file and redeploying therefore changes nothing
in an existing installation.

`scripts/migrate_keycloak_realm.py` applies the production security contract to an existing
realm in place (`migrate_keycloak_realm.py:1-2`). Its `--apply` mode binds the four exact
`karyo-web` callbacks beneath `KARYO_PUBLIC_ORIGIN`, disables the backend password grant, writes
`OIDC_SECRET` to the `karyo-backend` client and `KEYCLOAK_ADMIN_CLIENT_SECRET` to `karyo-admin`,
removes interactive credentials and federated identities from both service accounts and gives
them their least-privilege authority, and deletes the development realm's demo accounts - but
only accounts it can prove are unmodified fixtures that still accept their seeded passwords
(`migrate_keycloak_realm.py:33-70`). Use it whenever an existing Keycloak database carries
anything the production realm file does not: demo accounts, wildcard callbacks, or a
`karyo-backend` secret that fails the credential policy. `--reconcile-service-clients` restores
the two service clients alone and leaves human users and callbacks untouched
(`migrate_keycloak_realm.py:964-1025`).

**Decide first whether `OIDC_SECRET` must rotate.** Every deploy, including `--quick`, and the
migration both enforce the credential policy in `scripts/validate_credential.py`. A
`karyo-backend` secret that fails it - the development value `dev-backend-secret` in particular -
is rejected, so the change becomes a genuine secret rotation. Decide this now rather than at step
5 with the stack half-changed.

`docker-compose.maintenance.yml` is the only way to reach Keycloak's admin interface. The
production Compose file publishes no Keycloak port, so `/auth/admin` and the Admin REST API are
never addressable from the deploy host; this twelve-line file adds a `127.0.0.1`-bound port for
the duration of a maintenance window, and taking it down again is a mandatory numbered step
rather than a clean-up afterthought (`docker-compose.maintenance.yml:1-12`).

1. **Isolate the identity service, then take a restorable backup of the Keycloak database and
   prove it restores, before anything else.** Step 6 rotates the `karyo-backend` client secret and
   retires accounts; a run that fails partway is only recoverable from a backup already known to
   be good.

   ```bash
   python3 scripts/render_compose_env.py scripts/.env.prod >/dev/null
   docker compose -f infrastructure/docker/docker-compose.prod.yml \
     stop karyo-app nginx keycloak
   test -z "$(docker compose -f infrastructure/docker/docker-compose.prod.yml \
     ps --status running -q karyo-app nginx keycloak)"
   install -m 0600 /dev/null keycloak-pre-migration.dump
   docker compose -f infrastructure/docker/docker-compose.prod.yml exec -T postgresql \
     sh -c 'pg_dump -U "$POSTGRES_USER" -Fc keycloak' > keycloak-pre-migration.dump
   test "$(stat -c '%a' keycloak-pre-migration.dump)" = 600

   # Prove the dump restores before trusting it. Every command here must exit 0.
   docker compose -f infrastructure/docker/docker-compose.prod.yml exec -T postgresql \
     sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -c "CREATE DATABASE keycloak_restore_check"'
   docker compose -f infrastructure/docker/docker-compose.prod.yml exec -T postgresql \
     sh -c 'pg_restore -U "$POSTGRES_USER" -d keycloak_restore_check' < keycloak-pre-migration.dump
   docker compose -f infrastructure/docker/docker-compose.prod.yml exec -T postgresql \
     sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d keycloak_restore_check \
       -c "SELECT count(*) FROM user_entity"'
   docker compose -f infrastructure/docker/docker-compose.prod.yml exec -T postgresql \
     sh -c 'psql -U "$POSTGRES_USER" -c "DROP DATABASE keycloak_restore_check"'
   ```

   Keep `keycloak-pre-migration.dump` until step 8 has verified the deployment end to end. It
   contains password hashes and client secrets: store it as a secret and delete it afterwards.

2. **With the isolation still in place, create a temporary master-realm maintenance
   administrator while Keycloak is stopped, then expose only the loopback maintenance port.** The
   password is read into the shell and passed by environment variable, never as a command-line
   argument.

   ```bash
   export KARYO_KEYCLOAK_MAINTENANCE_PORT="$(
     grep '^KARYO_KEYCLOAK_MAINTENANCE_PORT=' scripts/.env.prod | cut -d= -f2-
   )"
   : "${KARYO_KEYCLOAK_MAINTENANCE_PORT:=8181}"
   export KARYO_KEYCLOAK_MAINTENANCE_URL="http://127.0.0.1:${KARYO_KEYCLOAK_MAINTENANCE_PORT}/auth"
   read -rp 'Temporary Keycloak maintenance username: ' KARYO_KEYCLOAK_MAINTENANCE_USERNAME
   read -rsp 'Temporary Keycloak maintenance password: ' KARYO_KEYCLOAK_MAINTENANCE_PASSWORD
   echo
   export KARYO_KEYCLOAK_MAINTENANCE_USERNAME KARYO_KEYCLOAK_MAINTENANCE_PASSWORD
   ./scripts/migrate_keycloak_realm.py --validate-maintenance-credentials

   docker compose -f infrastructure/docker/docker-compose.prod.yml \
     stop karyo-app nginx keycloak
   test -z "$(docker compose -f infrastructure/docker/docker-compose.prod.yml \
     ps --status running -q karyo-app nginx keycloak)"
   docker compose -f infrastructure/docker/docker-compose.prod.yml \
     run --rm --no-deps \
     -e KARYO_KEYCLOAK_MAINTENANCE_USERNAME \
     -e KARYO_KEYCLOAK_MAINTENANCE_PASSWORD \
     keycloak bootstrap-admin user \
     --username:env KARYO_KEYCLOAK_MAINTENANCE_USERNAME \
     --password:env KARYO_KEYCLOAK_MAINTENANCE_PASSWORD --no-prompt
   docker compose -f infrastructure/docker/docker-compose.prod.yml \
     -f infrastructure/docker/docker-compose.maintenance.yml \
     up -d --no-deps --force-recreate keycloak
   for _ in $(seq 1 150); do
     curl --noproxy '*' --fail --silent \
       "${KARYO_KEYCLOAK_MAINTENANCE_URL}/realms/master" >/dev/null && break
     sleep 2
   done
   curl --noproxy '*' --fail --silent \
     "${KARYO_KEYCLOAK_MAINTENANCE_URL}/realms/master" >/dev/null
   test -z "$(docker compose -f infrastructure/docker/docker-compose.prod.yml \
     ps --status running -q karyo-app nginx)"
   ./scripts/migrate_keycloak_realm.py --verify-maintenance-admin
   ```

   Do not continue unless the final three commands succeed. The tool accepts only a literal
   loopback HTTP `/auth` URL with an explicit port; it cannot send maintenance credentials through
   nginx, a public origin or a redirect (`migrate_keycloak_realm.py:197-231`).

3. **Settle both secrets, and make sure each satisfies the credential policy.**

   - `KEYCLOAK_ADMIN_CLIENT_SECRET`: generate a distinct securely random secret of at least 32
     characters and put it in `scripts/.env.prod`.
   - `OIDC_SECRET`: check the current value.

     ```bash
     printf '%s' "$(grep '^OIDC_SECRET=' scripts/.env.prod | cut -d= -f2-)" |
       python3 scripts/validate_credential.py --min-length 32 --username karyo-backend --env-literal
     ```

     Exit 0 means it qualifies and may be kept. Any other exit means it does not: generate a
     replacement (`python3 -c 'import secrets; print(secrets.token_urlsafe(36))'`), put it in
     `scripts/.env.prod`, and treat the change as a `karyo-backend` secret rotation. The migration
     writes whichever value is supplied to the client, so the realm and the environment file end
     up in step.

4. **Export the deployment-bound origin and the two secrets settled in step 3:**

   ```bash
   export KARYO_PUBLIC_ORIGIN='https://wms.example.com'
   export KEYCLOAK_ADMIN_CLIENT_SECRET='<the same distinct secret as in scripts/.env.prod>'
   export OIDC_SECRET='<the same backend secret as in scripts/.env.prod>'
   ```

5. **Leave the application and nginx stopped and run**
   `./scripts/migrate_keycloak_realm.py --apply --verified-backup --isolated-maintenance`. The
   backup flag attests that step 1's restore check succeeded, and the isolation flag attests that
   step 2 stopped every ordinary route; without either the tool refuses before contacting
   Keycloak (`migrate_keycloak_realm.py:1014-1025`). Before any change it proves, for every
   candidate account, both that its complete fixture fingerprint matches - attributes, direct
   realm roles, group membership, required actions and identity-provider state - and that it still
   authenticates with its seeded credential. An account whose profile changed, whose password was
   rotated, or which cannot be probed conclusively makes the tool refuse the whole run without
   touching the realm. Move the affected operator to a separately named account or resolve the
   identity by hand, then rerun.

6. **The run deletes only the accounts proven in step 5.** It revokes all realm sessions and each
   candidate's sessions, then waits out the realm's longest configured access-token lifespan while
   the application, nginx and every other ordinary route stay stopped, so a bearer token minted
   just before maintenance expires before the application returns. For the production realm that
   wait is 900 seconds. The wait is an outage, so the tool prints `Planned access-token drain:
   <n> seconds (longest lifespan: <source>)` **before** it revokes or deletes anything, naming the
   realm setting or client attribute that set the length. A drain longer than 3600 seconds is
   refused before any change: lower that lifespan in Keycloak and rerun, or accept the outage
   explicitly with `--max-drain-seconds <n>` (`migrate_keycloak_realm.py:26-32`). Both
   client-credentials grants are verified before deletion and again after the drain. Deletion is
   recoverable only from the verified step-1 backup. A successful rerun deletes nothing but repeats
   the normalisation, session revocation and drain.

7. **Retire the temporary administrator while Keycloak is still reachable only on loopback**, then
   take the maintenance port back down. The first command deletes the authenticated account from
   the master realm and proves the same credentials can no longer obtain a token:

   ```bash
   ./scripts/migrate_keycloak_realm.py --retire-maintenance-admin
   unset KARYO_KEYCLOAK_MAINTENANCE_USERNAME KARYO_KEYCLOAK_MAINTENANCE_PASSWORD
   ```

   Taking the port down is mandatory: recreating Keycloak from the production file alone restores
   the posture in which only nginx can reach the identity service. The check below reads the host's
   listening sockets rather than any container-runtime output, because the port forwarder binds the
   socket as soon as the container starts. It takes the port from `scripts/.env.prod`, so it is safe
   to rerun from a fresh shell; a present but non-numeric value stops the step rather than silently
   widening the filter, and an absent value falls back to 8181, the same default step 2 used. Only
   the success branch clears the maintenance variables, so a stop leaves everything needed to retry.
   Proceed only when it reports the expected port closed.

   ```bash
   docker compose -f infrastructure/docker/docker-compose.prod.yml \
     up -d --no-deps --force-recreate keycloak
   maintenance_port="$(
     grep '^KARYO_KEYCLOAK_MAINTENANCE_PORT=' scripts/.env.prod | cut -d= -f2-
   )"
   : "${maintenance_port:=8181}"
   if ! printf '%s' "$maintenance_port" | grep -qE '^[0-9]+$'; then
     echo "STOP: KARYO_KEYCLOAK_MAINTENANCE_PORT is not a port number: '$maintenance_port'" >&2
     false
   elif ! bound="$(ss -tlnH "sport = :$maintenance_port")"; then
     echo 'STOP: could not query the host listening sockets' >&2
     false
   elif [ -n "$bound" ]; then
     printf '%s\n' "$bound" >&2
     echo "STOP: port $maintenance_port is still bound on this host" >&2
     false
   else
     echo "Port $maintenance_port is closed; Keycloak is reachable only through nginx"
     unset KARYO_KEYCLOAK_MAINTENANCE_URL KARYO_KEYCLOAK_MAINTENANCE_PORT maintenance_port bound
   fi
   ```

8. **Validate and deploy in full**: `./scripts/deploy-server.sh --validate-env scripts/.env.prod`,
   then `./scripts/deploy-server.sh` without `--quick`. Verify login auditing, then user
   creation, deactivation, reactivation, role assignment and password reset through Karyo. Clear
   the remaining values:

   ```bash
   unset KARYO_PUBLIC_ORIGIN KEYCLOAK_ADMIN_CLIENT_SECRET OIDC_SECRET
   ```

### Rolling back a failed realm change

A refusal needs no rollback: the tool changes nothing when a preflight check fails, so read the
message, fix the named condition and rerun. Once any Keycloak write has been attempted, even a
lost response makes the outcome ambiguous: the failure starts with `REALM MIGRATION MAY BE
PARTIALLY APPLIED` and stops the deployment. Roll back whenever that message appears, or when
Karyo fails to start after an otherwise successful run.

1. Stop the application, the public proxy and Keycloak, so nothing writes while the database is
   replaced and no ordinary route can reach the restored identity service:

   ```bash
   docker compose -f infrastructure/docker/docker-compose.prod.yml stop karyo-app nginx keycloak
   test -z "$(docker compose -f infrastructure/docker/docker-compose.prod.yml \
     ps --status running -q karyo-app nginx keycloak)"
   ```

2. Restore the step-1 dump over the Keycloak database:

   ```bash
   docker compose -f infrastructure/docker/docker-compose.prod.yml exec -T postgresql \
     sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -c "DROP DATABASE keycloak"'
   docker compose -f infrastructure/docker/docker-compose.prod.yml exec -T postgresql \
     sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" \
       -c "CREATE DATABASE keycloak OWNER \"$POSTGRES_USER\""'
   docker compose -f infrastructure/docker/docker-compose.prod.yml exec -T postgresql \
     sh -c 'pg_restore -U "$POSTGRES_USER" -d keycloak' < keycloak-pre-migration.dump
   ```

3. Recreate and verify a temporary maintenance administrator. The step-1 dump was taken before
   that account existed, so the restore removed it. Run exactly the command block from step 2 of
   the procedure above.

4. Keep the application and nginx stopped. Generate a new `karyo-backend` secret for the restored
   realm, enter it at a hidden prompt, and validate it before any realm change:

   ```bash
   read -rsp 'New restored karyo-backend client secret: ' OIDC_SECRET
   echo
   export OIDC_SECRET
   printf '%s' "$OIDC_SECRET" |
     python3 scripts/validate_credential.py --min-length 32 --username karyo-backend --env-literal
   ```

   Put this exact value in the `OIDC_SECRET` assignment in `scripts/.env.prod` without passing it
   on a command line. Reuse neither the earlier secret nor the failed run's secret.

5. Select a distinct policy-compliant `karyo-admin` secret and put it in the
   `KEYCLOAK_ADMIN_CLIENT_SECRET` assignment:

   ```bash
   read -rsp 'Restored karyo-admin client secret: ' KEYCLOAK_ADMIN_CLIENT_SECRET
   echo
   export KEYCLOAK_ADMIN_CLIENT_SECRET
   printf '%s' "$KEYCLOAK_ADMIN_CLIENT_SECRET" |
     python3 scripts/validate_credential.py --min-length 32 --username karyo-admin --env-literal
   ```

6. Export the deployment's exact public origin, then rerun the complete hardening through the
   loopback Admin API while every public route stays stopped:

   ```bash
   export KARYO_PUBLIC_ORIGIN="$(grep '^KARYO_PUBLIC_ORIGIN=' scripts/.env.prod | cut -d= -f2-)"
   ./scripts/migrate_keycloak_realm.py --apply --verified-backup --isolated-maintenance
   ```

   Do not continue unless it succeeds. Never substitute `--reconcile-service-clients` here: that
   mode deliberately leaves human users and `karyo-web` callbacks unchanged. If a restored human
   identity no longer matches the fixture fingerprint, keep the deployment isolated, resolve that
   identity by hand, and rerun the complete hardening.

7. Retire the temporary administrator and take the maintenance port down, exactly as in step 7 of
   the procedure above.

8. Only then validate the environment and restore public service:

   ```bash
   ./scripts/deploy-server.sh --validate-env scripts/.env.prod
   ./scripts/deploy-server.sh --quick
   ```

   Sign in through the browser, confirm login auditing records events (**Admin > Audit log**),
   then create a temporary user through **Admin > Users**, reset its password, change a role and
   deactivate it. If any check fails, the restored deployment is incomplete. Clear the exported
   values with `unset KARYO_PUBLIC_ORIGIN KEYCLOAK_ADMIN_CLIENT_SECRET OIDC_SECRET`.

The tool deletes proven fixture accounts. Only the verified backup recovers a mistaken deletion.

## Running the deploy script

Re-running the script stops and recreates the selected stack, so plan an outage and identify the
stack's project, ports, images and storage first (`deploy-server.sh:7`).

### Selecting the deployment

The script defaults to Compose project `karyo-prod`, application image `karyo/karyo-app:latest`
and nginx image `karyo/nginx:latest` (`deploy-server.sh:520-524`). For a second, isolated
rehearsal on a shared runtime, inspect the existing resources and choose an unused project name,
image tags and host port:

```bash
export COMPOSE_PROJECT_NAME=karyo-guide
export NGINX_HTTP_PORT=18088
export KARYO_APP_IMAGE=karyo/karyo-app:guide
export KARYO_NGINX_IMAGE=karyo/nginx:guide
export BASE_URL=http://localhost:18088
```

Export `COMPOSE_PROJECT_NAME`, `KARYO_APP_IMAGE` and `KARYO_NGINX_IMAGE` in the invoking shell;
the script does not read these three from `scripts/.env.prod`. Keep them set for every deploy,
restart, maintenance and browser-test invocation, including direct Compose commands. Give this
checkout its own mode-0600 environment file with the matching origin and hostname settings. An
explicit `NGINX_HTTP_PORT` in that file overrides the exported port (`deploy-server.sh:713-717`),
so keep the two aligned.

Compose project names isolate containers, networks and volumes. Explicit image tags avoid
overwriting another stack's tags; a project name alone changes neither images, browser origin nor
host port. Health and database-password probes select containers by Compose project and service
labels on both Docker Compose and `podman-compose` (`deploy-server.sh:164-170`). The script never
prunes images, including untagged ones: clean-up is an explicit operator action. Never reuse
another deployment's identities, storage or credentials. `BASE_URL` selects the browser-test
target for `scripts/run-e2e.sh`, not the deployment origin.

### The flags

| Command | What it does |
|---|---|
| `./scripts/deploy-server.sh` | Full rebuild: Gradle, both front ends, and both images with `--no-cache`. Preserves the selected project's database volume |
| `./scripts/deploy-server.sh --quick` | Skips Stages 2-4 and restarts containers only. For environment or configuration changes; it compiles nothing, so a source change needs a full rebuild |
| `./scripts/deploy-server.sh --reset-db` | Destroys the selected project's database volume, PostgreSQL and Keycloak data together, and starts fresh. Needs new one-time bootstrap credentials |
| `./scripts/deploy-server.sh --validate-env FILE` | Validates one environment file and exits |
| `./scripts/deploy-server.sh --help` | Shows the flags (`deploy-server.sh:50-70`) |

Flags combine: `./scripts/deploy-server.sh --quick --reset-db` restarts on a fresh database.

`--reset-db` runs `compose down -v` after two warning lines and no confirmation prompt
(`deploy-server.sh:739-743`). Use it only for an explicitly disposable deployment, and never to
hide a Flyway checksum mismatch on retained data.

## The eight stages

1. **Check prerequisites** - the host tools above, the container runtime's responsiveness, and
   on Podman the linger and unprivileged-port settings (`deploy-server.sh:530-586`).
2. **Build the backend** - `./gradlew :services:karyo-app:quarkusBuild -Dquarkus.profile=prod`
   (`deploy-server.sh:598-612`).
3. **Build the front ends** - `npm ci && npm run build` in `frontend/web` and `frontend/mobile`
   (`deploy-server.sh:618-641`).
4. **Build both images** with a determinism setting and `--no-cache`
   (`deploy-server.sh:647-675`); see [container images](container-images.md).
5. **Check the environment file** - create it if missing, enforce mode 0600, validate it and render
   the four service files (`deploy-server.sh:690-728`).
6. **Start infrastructure** - tear down the previous run, check ports, start PostgreSQL, verify the
   persisted role password, decide whether Keycloak's database is fresh, then start Keycloak
   (`deploy-server.sh:734-784`).
7. **Start the application** - `karyo-app`, then nginx, each with its own bounded health wait
   (`deploy-server.sh:790-797`).
8. **Verify the stack** - four API probes through nginx, a realm check and an SPA check
   (`deploy-server.sh:803-838`).

`--quick` skips Stages 2-4; `--reset-db` adds volume destruction to Stage 6. The interesting parts
are the orderings, each of which exists because something went wrong once.

**Stage 6 starts PostgreSQL alone, first.** `verify_postgres_role_password` then authenticates
the *persisted* role with the password from the environment file, before Keycloak or the
application are allowed to start (`deploy-server.sh:752-759`). Credentials are expanded inside
the container shell, never in the host command arguments (`deploy-server.sh:207-216`).

**Bootstrap credentials are decided by the database.** See
[Provisioning the first administrator](#provisioning-the-first-administrator).

**Health waits are per service and bounded separately.** Keycloak gets 420 seconds rather than
200, because on a cold volume it runs Liquibase to build its entire schema and then imports the
realm - measured at 224 seconds on an empty database. Warm starts take about 30 seconds, so the
headroom costs nothing in the common case (`deploy-server.sh:778-784`). The Compose
`start_period` values exist for the same reason and are commented the same way
(`docker-compose.prod.yml:19-25,60-63`).

**Stage 7 starts the application and nginx one at a time**, each with its own wait, because
starting nginx in the same Compose call can wait forever for a restart-looping application before
the script's own timer runs (`deploy-server.sh:792-797`). A wait that times out prints the last
twenty lines of that service's log (`deploy-server.sh:120-145`).

`check_service_healthy` matches the health status **exactly**, because a plain
`grep -q "healthy"` also matches "unhealthy" (`deploy-server.sh:179-180`), and containers are
selected by Compose project and service labels rather than by name substring, so a healthy
container from another deployment cannot conceal this stack's failure
(`deploy-server.sh:164-170`).

What "healthy" means differs per service. PostgreSQL runs `pg_isready`, the application and
nginx run `wget` against `/q/health/ready` and `/`, and Keycloak opens a bare TCP socket against
its management port - even though the same service block enables the readiness endpoint on that
port (`docker-compose.prod.yml:14-18,47-48,55-59,88-92,112-116`). Why Keycloak's check proves
less than the endpoint it enables is not recorded.

## What Stage 8 proves

Four `GET`s through nginx - `/api/v1/{stock-units,products,locations,users}` - counted as healthy
on 200, 401 or 403, plus a Keycloak realm check and an SPA check that only warn
(`deploy-server.sh:805-838`).

Accepting 401 and 403 is right: the probe is unauthenticated, and a route that refuses it is
working. What it proves is therefore routing, not authorised functionality. A healthy backend does
not prove that Keycloak or browser sign-in works; sign in through the exact public origin before
calling an installation ready (see
[verifying an installation](operating-an-installation.md#verifying-an-installation)).

## The four containers

`infrastructure/docker/docker-compose.prod.yml`, project `karyo-prod`, one bridge network, one
named volume:

| Service | Image | Published |
|---|---|---|
| `postgresql` | `docker.io/postgres:16-alpine` | nothing |
| `keycloak` | `quay.io/keycloak/keycloak:26.0` | nothing |
| `karyo-app` | `${KARYO_APP_IMAGE:-karyo/karyo-app:latest}` | nothing |
| `nginx` | `${KARYO_NGINX_IMAGE:-karyo/nginx:latest}` | `${NGINX_HTTP_PORT:-80}:80` |

Only nginx binds a host port. Keycloak is reachable **only** through nginx in an ordinary
deployment, which is what makes `/auth/admin` and the Admin REST API unreachable from the deploy
host (`docker-compose.maintenance.yml:1-8`).

Two details are worth carrying. The `image:` keys are explicit so that `compose up` runs the
freshly built image instead of a stale project-named one (`docker-compose.prod.yml:74-76`). And
`KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true` makes internal service-to-service OIDC discovery return
`http://keycloak:8080` while browser requests still use the external `KC_HOSTNAME`
(`docker-compose.prod.yml:40-44`) - the single setting that lets one Keycloak serve both an
in-network client and a browser behind a proxy.

`infrastructure/docker/init-db.sh` runs only on the first start of an empty data directory - a
property of the PostgreSQL image's entrypoint, not a fault. It creates the `karyo` schema
(belt-and-braces, since Flyway has `create-schemas: true`) and the `keycloak` database
(`init-db.sh:4-13`).

The port pre-flight checks `NGINX_HTTP_PORT` **and 5432** (`deploy-server.sh:470-491`), and the
production stack publishes no 5432: the `postgresql` service has no `ports` key
(`docker-compose.prod.yml:7-28`). **Known defect.** Any local PostgreSQL, or a development stack,
blocks a production deploy with a message that names a real process and implies a conflict that
does not exist. Identify the owner of the process before acting; never stop another deployment to
clear it.

## Public access

The stack serves plain HTTP on one host port. Nothing in this repository configures a
certificate, so TLS must terminate in front of the stack, at a reverse proxy or a tunnel.

One route that needs no open firewall port is a Cloudflare Tunnel, which is why the deploy script
checks for `cloudflared` and only warns when it is absent (`deploy-server.sh:537-538,848-852`):

1. Install `cloudflared` and authenticate with `cloudflared tunnel login`.
2. Create a tunnel: `cloudflared tunnel create karyo`.
3. Route your domain to `http://localhost:80` (or the chosen `NGINX_HTTP_PORT`).
4. Start it as a service: `sudo systemctl enable --now cloudflared`.

Whatever terminates TLS, `KARYO_PUBLIC_ORIGIN`, `KARYO_DOMAIN` and `KC_HOSTNAME` must name the
origin browsers actually use.

## Rootless Podman

Docker runs as a root daemon and needs neither of these. Two host-level prerequisites are warned
about rather than enforced, because both need root:

- **Linger**, so containers survive an SSH disconnect (`deploy-server.sh:553-560`):

  ```bash
  sudo loginctl enable-linger $(whoami)
  ```

- **Binding port 80** without root (`deploy-server.sh:562-570`):

  ```bash
  sudo sysctl -w net.ipv4.ip_unprivileged_port_start=80
  echo 'net.ipv4.ip_unprivileged_port_start=80' | sudo tee -a /etc/sysctl.conf
  ```

  Or skip the sysctl and run nginx on a high port by setting `NGINX_HTTP_PORT=8088`; the stack is
  then at `http://localhost:8088`.

## Cloud hosts

The same script deploys to a cloud virtual machine. Install Docker with the Compose plugin, a JDK
21, Node.js 24.x (the line declared once in `.nvmrc`), Python 3, Git and, if used, `cloudflared`; clone the repository;
create `scripts/.env.prod` from `scripts/.env.prod.cloud-example`, whose resource limits suit a
24 GB four-core ARM64 host; export `GRADLE_OPTS` for a larger build heap; and run
`./scripts/deploy-server.sh`. Every base image in the stack has an ARM64 variant:
`postgres:16-alpine`, `quay.io/keycloak/keycloak:26.0`, `eclipse-temurin:21-jre-alpine`,
`node:24-alpine` and `nginx:1.30.4-alpine`.

## Every deploy is an outage

The script's own header says "Re-running recreates the selected stack; plan an outage"
(`deploy-server.sh:7`). Stage 6 runs `compose down --remove-orphans` before anything starts, and
`--reset-db` makes that `down -v` (`deploy-server.sh:736-747`). There is no rolling restart, no
second replica and no blue/green: one host, one instance, and a stop before the start. That
follows from the topology and is deliberate; its cost is a planned window for every change,
including a configuration-only `--quick`.

## Troubleshooting a deploy

**"Port X in use".** The pre-flight runs in Stage 6, after the selected project's containers are
torn down, and uses `ss` to find what holds the nginx port or 5432, naming the process and its
PID. Identify its owner before acting. Choose an unused nginx port and a matching origin, or
resolve the conflict with the host's operator. For 5432, see [the four containers](#the-four-containers).

**"Health check timeout".** The script prints the last 20 lines of the service's log. Common
causes: for PostgreSQL, a wrong password in the environment file or a full disk; for Keycloak, a
slow first start while it imports the realm, or database connectivity; for the application,
database connection errors, an unreachable Keycloak, or a Flyway migration failure (see
[upgrade, backup and recovery](upgrade-backup-and-recovery.md)).

**"Required variables not configured".** Replace every `CHANGE_ME` value. The script validates
every required variable, requires the bootstrap password, the administration-client secret and the
OIDC secret to be distinct, rejects weak or known demo credentials, and requires
`KARYO_PUBLIC_ORIGIN` to be one exact browser-canonical origin. It fails before starting any
container.

**"Flyway checksum mismatch".** Restore the applied migration file's exact released bytes,
including comments, and put any schema correction in a new forward migration; a new migration
alone cannot fix the checksum of an edited old file. Do not repair, re-baseline or renumber
retained data to conceal a mismatch. `--reset-db` is only for explicitly disposable data.

**Podman: a health check hangs.** Exec-based health checks can hang under Podman; Docker is
unaffected (`deploy-server.sh:756-758`). If Keycloak's check hangs, rerun the script; the second
run usually succeeds. Switch to Docker if it happens often.

**"init-db.sh did not run on redeploy".** Expected: it runs only when the data directory is
empty. For a new database object after the first deployment, run the SQL against the running
PostgreSQL container, or use `--reset-db` on a disposable deployment.

For failures after a successful deploy - sign-in loops, missing menu entries, orders that will
not move - see [troubleshooting](troubleshooting.md).

## Related

- [Operating an installation](operating-an-installation.md) - schedulers, health, logs and the
  maintenance window
- [Upgrade, backup and recovery](upgrade-backup-and-recovery.md) - moving to a new release, and
  backing up and restoring both databases
- [Container images](container-images.md) - what Stages 2-4 produce
- [Licence and entitlement](licence-and-entitlement.md) - the licensing variables in the
  environment file
- [Identity and tenancy](../architecture/identity-and-tenancy.md) - what the user attributes mean
- [ADR 0013](../architecture/decisions/0013-keycloak-oidc.md) - Keycloak as the identity provider
- [ADR 0022](../architecture/decisions/0022-compose-four-container-deployment.md) - Compose with
  four containers as the supported deployment
