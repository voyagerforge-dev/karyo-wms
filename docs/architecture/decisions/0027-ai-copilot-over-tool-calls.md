# ADR 0027: An optional AI copilot works through tool calls, not retrieval

**Status:** Accepted

## Context

Warehouse staff ask questions whose answers are in Karyo's own data: what is expiring, which orders
are open, what needs replenishing, what just happened. A language model can turn a question like
that into the right queries and a readable answer - but only if it reads current data. An answer
built on stale or guessed numbers is worse than no answer, because someone will act on it. Some of
those questions end in an action, such as receiving or moving stock, which must not happen on a
model's say-so.

Warehouse operations themselves - selecting stock, finding a location, releasing work - have to be
deterministic and must not depend on a model at all.

## Decision

- **Karyo includes an optional copilot**, in `karyo-ai-core`, served at `/api/v1/ai`. It is off
  unless configured: `karyo.ai.provider` (`KARYO_AI_PROVIDER`) selects `anthropic`, `ollama` or
  `none`, and `none` is the default. With `none`, `POST /api/v1/ai/chat` answers 503.
- **It is built on LangChain4j** through its Quarkus extension. Two named models are fixed when the
  application is built - `claude` on Anthropic and `local` on Ollama - and the runtime setting
  chooses between them. There is no automatic fallback from one provider to the other.
- **The model answers by calling tools**, and the tools call Karyo's services in process, under the
  caller's identity: read tools, insight tools - including recent warehouse activity, read from the
  outbox (ADR 0009) - and action tools.
- **An action tool never acts.** It checks the caller's write role and stores a proposal. The action
  runs only when the same user confirms it (`POST /api/v1/ai/confirm/{id}`), and the confirmation
  checks ownership and then the write role again before anything executes.
- **There is no retrieval over an embedding store**: no vector extension, no embedding table and no
  document index.
- **No operational path calls the copilot.** Every warehouse decision is made by deterministic code.

## Consequences

- A deployment that does not want AI has none. The default is off, and nothing else in the product
  calls a model.
- The copilot knows only what its tools return, read from live data at the moment of the question.
- With `anthropic`, the conversation and every tool result it draws on are sent to Anthropic's API.
  With `ollama`, they go to the Ollama server named by `OLLAMA_URL`.
- Both provider extensions are in every image. The Anthropic key has a non-empty placeholder
  default, because the extension validates it at startup even when the provider is `none`.
- Questions about documents that are not in the database - procedures, manuals - cannot be
  answered; nothing indexes them.
- Why a self-hosted provider is offered beside the hosted one, and why the copilot ships switched
  off, are not recorded.

## Alternatives considered

- **Retrieval over a vector store in PostgreSQL, feeding stored documents to the model.** Not built.
  It answers a different question - what do our documents say - from the one the copilot answers -
  what is true in the warehouse now. Why it has not been built is not recorded.
- **Automatic fallback from the hosted provider to the local one.** Not built; the provider is
  chosen by configuration.
- **An LLM framework in another language, run as a separate service.** Rejected: a second runtime,
  a second build and a network hop, where LangChain4j runs in the same JVM and joins Quarkus's
  dependency injection (`@RegisterAiService`, `@Tool`).
- **Calling a provider's API directly, with no framework.** Rejected: the tool-calling protocol,
  conversation memory and the abstraction over providers would all have to be written and kept.
- **Another hosted model family.** The hosted provider was chosen for reliable tool calling, because
  a wrong tool call returns wrong warehouse data. The model itself is configuration
  (`KARYO_AI_ANTHROPIC_MODEL`, `KARYO_AI_OLLAMA_MODEL`).

## Evidence

- `services/karyo-app/src/main/resources/application.yaml:105-128` - two named models, fixed at
  build time
- `karyo-app/.../application.yaml:117` - the placeholder key; `:159` - the provider switch, `none`
  by default
- `services/ai-service/karyo-ai-core/src/main/kotlin/com/karyo/ai/config/AiConfig.kt:6-19`
- `.../ai/service/CopilotService.kt:8-19` - provider selection; `none` refuses
- `.../ai/service/ClaudeCopilot.kt:12` and `.../ai/service/LocalCopilot.kt:12` - one set of tools,
  two models
- `.../ai/tools/WarehouseActionTools.kt:15-22,45-54` - the write role checked, a proposal stored
- `.../ai/tools/WarehouseInsightTools.kt:167-168` - recent activity, from the outbox
- `services/ai-service/karyo-ai-core/src/main/kotlin/com/karyo/ai/api/v1/CopilotResource.kt:33-51` -
  chat, and 503 when off
- `CopilotResource.kt:53-78` - confirm: ownership, then role, then execute
- `services/ai-service/karyo-ai-core/build.gradle.kts:33-42` - LangChain4j and both providers, and
  no vector store
- [Events and the outbox](../events-and-outbox.md)

## Related

- [ADR 0009](0009-transactional-outbox.md) - the outbox the activity tool reads
- [ADR 0002](0002-kotlin-on-quarkus.md) - the platform the copilot runs on, in process
- [ADR 0013](0013-keycloak-oidc.md) - the roles the tools and the confirmation check
