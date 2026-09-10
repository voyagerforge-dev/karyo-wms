# Getting help

Most questions already have an answer in the documentation, and reading it is faster than waiting
for one. [docs/README.md](docs/README.md) maps every document, one line each.

Two things never go in a public issue:

- **A security vulnerability** goes to [SECURITY.md](SECURITY.md), privately, before it is fixed.
- **A conduct concern** goes to [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Where each question goes

| Your question | Start here |
|---|---|
| What is Karyo, and is it a fit for my warehouse? | [README](README.md) |
| How do I receive, pick, pack, count or replenish? | [User guide](docs/user-guide/README.md) |
| How do I set up a warehouse and prove it before real stock moves? | [Implementer guide](docs/guides/implementer-guide.md) |
| How do I deploy, upgrade, back up or recover an installation? | [Operations](docs/operations/README.md) |
| Something is failing on my installation | [Troubleshooting](docs/operations/troubleshooting.md), then a bug report |
| Exactly how does Karyo choose stock, a location or the next task? | [What Karyo does in a warehouse](docs/README.md#what-karyo-does-in-a-warehouse) |
| What can I configure, and who may configure it? | [Configuration](docs/README.md#configuration) |
| How do I connect another system, or extend Karyo? | [Integration and extension](docs/README.md#integration-and-extension) |
| How do I get it running on my machine to change it? | [Developer onboarding](docs/guides/developer-onboarding.md) |
| Why is it designed this way? | [Decision records](docs/architecture/decisions/README.md) |
| Is this feature free or commercial? | [Commercial engines](docs/commercial/README.md) |
| Is this a known defect? | [Open issues](https://github.com/voyagerforge-dev/karyo-wms/issues) |

## When the documentation does not answer it

Open an issue and pick the form that fits: a bug report, a feature request, a documentation
problem, or a question. Each form asks for what an answer needs. Search the open issues first: the
known defects are all there.

Three situations each have their own route:

- **The documentation is wrong, or two documents disagree.** That is a real defect: use the
  documentation form, quote the passage, and say what is actually true and how you know. A fix
  belongs in the document that owns the fact, and every other page should link to it.
- **You need a decision rather than an answer**, such as a change of scope or whether a capability
  is free or commercial. Propose it with the feature-request form; the maintainers decide.
- **You want to test against an installation someone else operates.** Ask its operator first. A
  live warehouse is never a test fixture.

## What this repository does not provide

- **A support desk for a running installation.** Karyo is self-hosted, and whoever operates an
  installation supports it. Issues here are for defects in Karyo, its documentation and its
  deployment material.
- **The commercial engines.** They are licensed separately and are not supported through this
  repository. [Commercial engines](docs/commercial/README.md) describes what each one does.
- **Credentials or access.** Never post credentials, licence tokens or customer records in an
  issue, even redacted ones you believe are expired.
