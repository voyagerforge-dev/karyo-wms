# Maintaining this repository

How the code, the documents and the decision records are kept true to each other. This is for
maintainers and for anyone whose change touches documented behaviour, which is most changes.

## What "true" means here

- **The documents describe Karyo as it behaves today**, including its known defects. A paragraph
  marked **Known defect** is current behaviour that is wrong and tracked as an issue.
- **There are no historical documents.** Nothing here records how Karyo used to work or what it
  was once meant to be. When behaviour changes, the document that describes it is rewritten, and git
  history is the record of what it said before.
- **Every claim can be checked.** Documents cite the files their claims come from as `path:line`,
  relative to the repository root, so a reader can re-derive a claim instead of trusting it.
- **Defects live in the issue tracker**, not in documents about defects. The documents describe the
  behaviour; the issue describes what is wrong with it and names the documents its fix must update.

## Every fact has one owner

[docs/README.md](../README.md) lists every document, one line each. Each fact has one document that
owns it, and every other page links there rather than repeating it:

| The fact is about | Its owner is |
|---|---|
| What Karyo does in the warehouse, rule by rule | [`docs/functional/`](../README.md#what-karyo-does-in-a-warehouse) |
| What a person may configure, and who may | [`docs/configuration/`](../README.md#configuration) |
| What an outside system calls or receives | [`docs/integration/`](../README.md#integration-and-extension) |
| How it is built, deployed, run and recovered | [`docs/operations/`](../operations/README.md) |
| How it is put together | [`docs/architecture/`](../README.md#architecture) |
| Why it is that way | [`docs/architecture/decisions/`](../architecture/decisions/README.md) |
| What a user sees on a screen | [`docs/user-guide/`](../user-guide/README.md) |
| How to do a job with it | [`docs/guides/`](../README.md#guides) |

Adding a document means adding its line to the map. Removing one means removing its line and every
link to it.

## When you change behaviour

1. **Update the owning document in the same pull request.** A behaviour change without its document
   is incomplete, whoever reviews it.
2. **When you fix a known defect, rewrite its passage.** The paragraph that said the behaviour was
   wrong now describes the fixed behaviour, and the **Known defect** label goes.
3. **Update every document the issue names.** An issue that describes a defect lists the documents
   its fix must update. The pull request updates each one, or says why one does not need it.
4. **Re-check citations into the files you changed.** Documents cite files by line, so a change can
   leave a citation pointing at the wrong lines. Search for the file's name under `docs/` and read
   each citation you find.
5. **Check the links you touched.** Every relative link and heading anchor must resolve. CI does not
   check documentation, so the author and the reviewer do.
6. **Change a decision deliberately.** If the change contradicts a
   [decision record](../architecture/decisions/README.md), rewrite the record in the same pull
   request. A decision that no longer holds is deleted, not kept with a changed status.

## Writing a document

- Open with what the document covers, and name the files it is derived from where that is useful.
- Present tense, and the product as it is. No "originally", "used to", "will be" or dates of past
  decisions.
- Cite `path:line` for every claim someone might want to check. `...` may elide the middle of a long
  path; a bare `:61-66` means lines in the file cited just before.
- **Never invent a reason.** If nothing records why something is the way it is, say that it is not
  recorded. A plausible reason written down becomes indistinguishable from a real one.
- Keep headings stable once other documents link to them; an anchor is a contract.
- Plain punctuation: use a spaced hyphen ( - ) for a dash, never an em dash.

## The user guide

Every screen, field and control the [user guide](../user-guide/README.md) describes is checked
against the front-end and back-end source. A change to a screen updates its page in the same pull
request. The guide never describes a commercial engine the reader may not have; it says where one
would appear.

## Code comments are documentation too

A comment that cites a document must cite one that exists, and a comment must not narrate history.
**Known debt:** some comments still cite documents by paths that do not exist in this repository, or
describe earlier behaviour. When you touch such a file, fix the comment. Applied migrations are the
exception: their comments are part of the checksum and cannot change.

## Dependencies, notices and images

- **Versions** change in `gradle/libs.versions.toml`, the front-end lockfiles or the Dockerfiles, in a
  pull request of their own. A security floor for a platform-managed library goes through
  `securityFloor` in the root build.
- **`THIRD-PARTY-NOTICES.md` is maintained by hand** against the dependency manifests; nothing
  generates it. A dependency change that adds a licence obligation updates it in the same pull
  request.
- **A new image build site** is added to `scripts/check-image-reproducibility.sh`, or the
  reproducibility audit will not see it.
- **The Detekt baseline** is not a place to put new findings to get to green. Fix the finding.

## Tests and flakiness

A flaky test is a defect: file it, and fix the cause rather than retrying until it passes. Never
disable a test, widen an exemption or skip a suite to make a pull request green; the root build
fails any project whose deterministic test task is disabled or skipped.

## The issue tracker

Issues are the substrate: every defect, feature request, documentation problem and question is an
issue, with the forms in [`.github/ISSUE_TEMPLATE/`](../../.github/ISSUE_TEMPLATE/). A security report
never is: it goes through [SECURITY.md](../../SECURITY.md) and a private advisory.

## Settings outside the tree

A few things these documents rely on are repository settings, not files, and a maintainer keeps
them in place:

- **Private vulnerability reporting** is enabled, because [SECURITY.md](../../SECURITY.md) and
  [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md) route private reports through it.
- **Nobody pushes to `main` directly.** [CONTRIBUTING.md](../../CONTRIBUTING.md) states the rule;
  branch protection is what enforces it.
- **[CODEOWNERS](../../CODEOWNERS) names accounts with write access**, or GitHub ignores the entry.

## Related

- [Releasing](releasing.md) - cutting a version
- [Architecture guide](architecture-guide.md) - the invariants reviews hold changes to
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - the change route every contributor follows
