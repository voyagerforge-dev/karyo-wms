# Security policy

Karyo runs inside warehouses, where an inventory or access defect has physical consequences.
Security reports take priority over feature work.

## Reporting a vulnerability

Report it privately, and report it before you fix it or discuss it anywhere public.

Use GitHub's private vulnerability reporting: open this repository's **Security** tab and choose
**Report a vulnerability**. The report is visible only to you and the maintainers, and it becomes
the private advisory in which the fix is coordinated.

Do not open a public issue, pull request or discussion for a suspected vulnerability, and do not
put the detail in a commit message or a branch name. Those are public the moment they are pushed,
and they stay in history after the fix ships.

A report is most useful when it states:

- the affected version or commit, and whether any commercial engine was present;
- how the stack was deployed;
- the privilege the attacker starts from: unauthenticated, an authenticated user with a given
  role, an OPS or OWNER principal, a goods owner in a multi-owner instance, or an integrating
  system;
- the request or screen, the configuration involved, and the smallest reproduction you have;
- the impact you believe follows from it.

Remove real credentials, licence tokens, customer records and client values from anything you
attach.

## What counts as a security problem

Karyo is tenanted by silo, with goods owners inside one instance, so the sharpest edges are the
ones that cross an isolation boundary. [Identity and tenancy](docs/architecture/identity-and-tenancy.md)
describes the real model. Treat these as reportable:

- **Goods-owner isolation failures.** `client_id` is the goods owner. Reading, writing or counting
  another owner's stock, orders, documents or journal entries is a security defect, not a
  filtering bug. Owner id 0 is the system owner; treating it as an administrator is a defect.
- **Authorization failures.** Operation roles and `principal_kind` (OPS or OWNER) are independent.
  A missing check, a check on the wrong axis, or an absent principal kind resolving to anything
  other than OWNER.
- **Identity and token handling.** Claim mappers drifting between the realm's token-issuing
  clients, or between the development and production realms; the `karyo-admin` user-management
  identity reaching the `karyo-backend` audit identity's scope, or the reverse.
- **Entitlement bypass.** Running a commercial engine without a valid signed licence, or a
  licence granting an entitlement it does not carry. The public verification key has one home,
  in `libs/karyo-license`; a second copy is a defect.
- **Audit integrity.** Losing actor attribution on a background or scheduler path, or a stock
  mutation that should reach the inventory journal and does not.
- **Secret exposure.** A credential or private key committed to this repository, or a default that
  carries a usable credential into production.
- **Vulnerable dependencies in what ships.** Judged against the assembled application and its two
  images, not against the whole dependency graph. The Quarkus platform is applied as an enforced
  platform and overrides ordinary version constraints, so a dependency fix that does not go through
  the root build's `securityFloor` can be silently undone.

Out of scope: findings that need access already equivalent to what they demonstrate; issues in a
third-party dependency with no exploitable path through Karyo (report those upstream); and testing
against an installation you do not operate without its operator's permission. There is no bug
bounty.

## Supported versions

Security fixes are made on `main` and ship in the next release. Only the most recent release is
supported. Older releases are not patched; upgrading is the remediation.

## What happens after you report

The maintainers acknowledge the report, assess whether it reproduces, and tell you what they intend
to do. Until the fix is released, the detail stays in the private advisory. The fix lands with a
regression test that fails for the right reason on the old behaviour. When the fix is released the
advisory is published, crediting you unless you ask not to be credited.

Nobody weakens a gate, grants a role, resets a database or rotates a key to make a fix pass.

## Deploying Karyo safely

[Deploying Karyo](docs/operations/deploying.md) describes the supported path, and the checks it
describes are load-bearing rather than advisory. The production realm ships with no human users and
no fixed credentials; the first administrator is provisioned from one-time bootstrap credentials
that must then be retired. A deployment sets `KARYO_PUBLIC_ORIGIN` to its real, credential-free
origin, keeps the realm's exact callback URLs rather than widening them into wildcards, and
terminates TLS in front of the stack.
