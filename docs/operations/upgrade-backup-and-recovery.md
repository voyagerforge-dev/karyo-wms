# Upgrade, backup and recovery

How an installation moves to a new release, how its two databases are backed up and restored, and
what no restore can undo.

Derived from `services/karyo-app/src/main/resources/application.yaml`,
`scripts/deploy-server.sh`, `infrastructure/docker/docker-compose.prod.yml`,
`infrastructure/docker/init-db.sh`, `infrastructure/docker/nginx/nginx.conf` and
`scripts/migrate_keycloak_realm.py`.

## The schema moves forward when the application boots

`services/karyo-app/src/main/resources/application.yaml:30-40` configures one Flyway migrator over
seventeen module location sets, with `migrate-at-start: true`, `out-of-order: true`,
`schemas: karyo` and `create-schemas: true`
([ADR 0005](../architecture/decisions/0005-flyway-migrations-at-boot.md)).

`out-of-order` is there because per-module migrations interleave numerically - a layout `V308` can
ship after orders `V4xx` are already applied to a long-lived database - while each module's own
version range stays internally ordered (`application.yaml:36-39`). The location list matches the
migration directories on the classpath exactly, seventeen for seventeen. Four of them hold the
commercial engines' tables, which a free installation creates and leaves empty (see
[data and persistence](../architecture/data-and-persistence.md)).

The delivery consequence is that there is no migration step. Upgrading is replacing the image and
starting it, and the migration runs inside the application container during boot. If it fails,
the container never becomes healthy, and Stage 7 of the deploy script times out after 150 seconds
and prints the last twenty lines of its log (`scripts/deploy-server.sh:120-145,792-797`). Watch
startup through the first Flyway and Quarkus errors, not only the final health result.

## There is no way back from a migration

Flyway's open-source edition has no undo, and nothing here substitutes for one. The limits:

- **Image-only rollback** needs the retained, matching application **and** nginx images plus a
  compatible configuration, and it is safe only after proving that the old application accepts the
  current schema and identity state. A previous tag is not that proof. Keep every release's images
  rather than overwriting a mutable tag and hoping it still means the old one.
- **A schema change** is not undone by starting an older image: Flyway forward migrations have no
  automatic down migrations. Prefer a reviewed forward repair. Restoring a database instead needs
  a full recovery plan, writers stopped, a verified matching backup, and a decision to accept the
  loss of everything written since the backup.
- **An identity change** is rolled back through
  [the realm rollback procedure](deploying.md#rolling-back-a-failed-realm-change). Restoring old
  secrets or accounts can revive retired access.
- **Physical and external work** cannot be restored at all. Restoring software cannot put shipped
  cartons back on the dock, unpick a physical pallet or recall an acknowledgement another system
  has already received. Warehouse and integration owners must reconcile physical counts,
  reservations, queued requests and duplicate external messages before reopening. A database
  restore is never an undo button for warehouse movements.

A Flyway checksum mismatch has one correct answer: restore the applied migration file's exact
released bytes, including comments; put the correction in a new forward migration; and never
repair, re-baseline or renumber retained data to conceal it.

## Upgrading an installation

1. **Compare the installed and the target release**: application and nginx images, architecture,
   extensions, configuration, realm state and Flyway history. Identify added migrations and
   incompatible API or configuration changes. Recompile and test every extension against the
   target release, not just against the release it was written for.
2. **Rehearse** on isolated storage restored from a representative backup (see
   [Restoring](#restoring)), with identity, network and outbound effects isolated too. Test schema
   migration and restart, then the agreed warehouse and negative cases. Success on an empty
   database proves nothing about retained data.
3. **Prepare the window.** Obtain a go or no-go, communicate the outage, stop new warehouse work,
   and drain and reconcile queued operations and integrations. Capture the last known counts and
   external acknowledgements. Take a matching pre-upgrade backup (see [Backing up](#backing-up))
   and keep the old images.
4. **Change identity only through the realm procedure.** `--import-realm` skips an existing realm,
   so editing the realm file does not upgrade it; if the target release needs realm changes, use
   [changing an existing Keycloak realm](deploying.md#changing-an-existing-keycloak-realm). Do not
   recreate the realm, reuse bootstrap accounts or broaden service roles as a workaround.
5. **Install the target.** A source update needs a full rebuild; `--quick` compiles nothing. An
   image built elsewhere is started without rebuilding: load it, export both image references
   (`KARYO_APP_IMAGE`, `KARYO_NGINX_IMAGE`) and run `./scripts/deploy-server.sh --quick`. A full
   rebuild from a checkout of this repository alone produces the free image, so running one on a
   host that runs a commercial image replaces that image with the free one. Keep the existing
   credentials unless a reviewed rotation is part of the change. **Never use `--reset-db` for an
   upgrade.**
6. **Watch the first boot.** Read the first Flyway and Quarkus errors, not only the final health.
   Recreating the application or Keycloak alone is enough: nginx re-resolves its `upstream` names
   at runtime (`nginx.conf:78-109`), so it follows a replaced container to the new address on its
   own, within about ten seconds, and no longer has to be recreated alongside it. Finish
   verification (see
   [verifying an installation](operating-an-installation.md#verifying-an-installation)) before
   warehouse work and external effects resume.

## Backing up

Nothing in the repository takes a backup on its own (see
[Nothing takes a backup on its own](#nothing-takes-a-backup-on-its-own)); this is the procedure an
operator runs. Adapt retention, encryption, off-host transport and permissions to the
installation's own agreement. A dump on the same failed disk is not recovery. A complete backup
includes both the `karyo` and `keycloak` databases, the environment file and its secrets, the exact
application and nginx images, and any external integration checkpoints.

This is a maintenance outage: the ingress, the application's schedulers and every identity writer
stop, and PostgreSQL stays up. Run it from the deployment's own checkout, against an already
identified project, with any other database writer stopped first. With Podman, use
`podman-compose` in place of `docker compose` in the array.

```bash
set -euo pipefail
: "${COMPOSE_PROJECT_NAME:?select the existing project to back up}"
: "${BACKUP_DIR:?choose a new, protected backup directory}"
COMPOSE=(docker compose -p "$COMPOSE_PROJECT_NAME" -f infrastructure/docker/docker-compose.prod.yml)
umask 077
mkdir -m 700 "$BACKUP_DIR"   # must not already exist
"${COMPOSE[@]}" stop nginx karyo-app keycloak
"${COMPOSE[@]}" exec -T postgresql sh -c \
  'pg_dump -U "$POSTGRES_USER" -Fc karyo' > "$BACKUP_DIR/karyo.dump"
"${COMPOSE[@]}" exec -T postgresql sh -c \
  'pg_dump -U "$POSTGRES_USER" -Fc keycloak' > "$BACKUP_DIR/keycloak.dump"
sha256sum "$BACKUP_DIR/"*.dump > "$BACKUP_DIR/SHA256SUMS"
test -s "$BACKUP_DIR/karyo.dump" && test -s "$BACKUP_DIR/keycloak.dump"
```

Expected: every command exits zero, leaving two non-empty custom-format dumps and their checksums.
That is not proof of restore. If a dump fails, keep the writers stopped until a decision is made;
never label a partial pair a valid backup. `scripts/.env.prod` and the rendered service files hold
secrets: keep their recoverable state in the protected channel the dumps go to, never in a
repository or a ticket.

Restart the stack afterwards with the same exported project and image selection, using
`./scripts/deploy-server.sh --quick`, and verify it.

## Restoring

**Restore into a separately allocated PostgreSQL instance, never into the source project.**
Prepare empty `karyo` and `keycloak` databases and the required role, as
`infrastructure/docker/init-db.sh` does for a new installation (`init-db.sh:4-13`). Record the
source and restore container IDs and storage and check that they differ. The restoring PostgreSQL
tooling must support the dump's server version; preserve owners and privileges rather than masking
a missing role with flags.

```bash
# RESTORE_PG_CONTAINER is the verified, isolated PostgreSQL container, never a guessed default.
: "${RESTORE_PG_CONTAINER:?select the isolated restore container with empty databases}"
sha256sum -c "$BACKUP_DIR/SHA256SUMS"
docker exec -i "$RESTORE_PG_CONTAINER" sh -c \
  'pg_restore --exit-on-error -U "$POSTGRES_USER" -d karyo' < "$BACKUP_DIR/karyo.dump"
docker exec -i "$RESTORE_PG_CONTAINER" sh -c \
  'pg_restore --exit-on-error -U "$POSTGRES_USER" -d keycloak' < "$BACKUP_DIR/keycloak.dump"
```

Expected: both restores exit zero with no ignored errors. Then confirm the schemas and the Flyway
history, the owner, item, location and lot quantities, and the identity records against the backup
checkpoint, and boot the matching release in the isolated environment. Keep the restored
identities unreachable from outside that environment and block real outbound effects - this
procedure does not configure that isolation for you. A different origin needs deliberate realm
callback maintenance; never rewrite production callbacks to make a rehearsal pass.

Do not run `pg_restore` over a live, non-empty database with this procedure. Replacing an
installation's data in place is a recovery decision with data loss attached, taken with every
writer stopped and a verified matching backup in hand.

## Nothing takes a backup on its own

There is no scheduled dump, no sidecar, no backup volume and no retention job anywhere in the
Compose files, the deploy script or the workflow. That is deliberate: where backups go, how long
they are kept and how they are encrypted are decisions for the installation, and the repository
provisions no storage for them. Its cost is that nothing happens unless an operator makes it
happen.

The single named volume `karyo-pgdata` holds every warehouse record and all identity state
(`docker-compose.prod.yml:11-12,126-127`), and `--reset-db` destroys it with two warning lines and
no confirmation prompt (`deploy-server.sh:739-743`).

The one place a backup is mechanically required is the realm change, where
`scripts/migrate_keycloak_realm.py` refuses its irreversible account deletion without an explicit
`--verified-backup` flag attesting that a restore check succeeded
(`migrate_keycloak_realm.py:988-992,1021-1025`). That is the only backup gate in the system, and it
gates one procedure.

## The identity realm is changed inside an isolated window

Keycloak is the one component with a numbered maintenance procedure, and nothing else in the system
is protected as carefully. Its first step is a restorable backup of the Keycloak database that is
**proved** to restore, by restoring it into a throwaway database, before anything else happens; a
run that fails partway is recoverable only from a backup already known to be good. Its rollback
restores that dump with every public route stopped, and has to generate new client secrets for the
restored realm before anything starts. Both are in
[deploying](deploying.md#changing-an-existing-keycloak-realm).

## Flyway history, not a tag, describes the installed schema

A Git tag says which source a release was cut from. What an installation's database actually holds
is its Flyway history:

```bash
docker compose -f infrastructure/docker/docker-compose.prod.yml exec -T postgresql sh -c \
  'psql -U "$POSTGRES_USER" -d karyo -c "SELECT installed_rank, version, description, success
     FROM karyo.flyway_schema_history ORDER BY installed_rank"'
```

Compare it with the target release's migration directories before an upgrade, and record it with
every backup.

## Related

- [Deploying](deploying.md) - the deploy script, the realm procedure and its rollback
- [Operating an installation](operating-an-installation.md) - verifying an installation after an
  upgrade
- [Data and persistence](../architecture/data-and-persistence.md) - the schema and its migration
  bands
- [ADR 0004](../architecture/decisions/0004-one-postgresql-database-and-schema.md) - one database,
  one schema
- [ADR 0005](../architecture/decisions/0005-flyway-migrations-at-boot.md) - migrations at boot
