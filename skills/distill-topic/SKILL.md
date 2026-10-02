---
name: sediment-distill-topic
description: Distill a user's authorized topic into reusable knowledge with conditions, evidence, counterexamples and unresolved questions, then submit a human-reviewed proposal.
---

1. Follow the retrieval workflow in `../find-knowledge/SKILL.md`. Confirm the intended space and topic; search only inside the granted topic or item range.
2. Build a bounded material set with `knowledge_extract`. Use explicit `selection`, fields and a character budget. Inspect `coverage`, each fragment's `completeness`, stable IDs and revisions.
3. Use the user's own agent/model configuration to draft a document with the claim, applicable conditions, observations/evidence, counterexamples, unresolved questions and references. Sediment's API and MCP do not provide or read browser AI keys.
4. Keep interpretations attributed to their authors. Do not convert “我认同/我尝试过/暂时采用” into validated facts or team consensus.
5. Submit `knowledge_propose` with `action=create_note` or `suggest_experience`, explicit `space_id`, `content` and versioned `source_refs`. For an existing record, include `target_item_id` and `base_revision`.
6. Return the proposal ID and review URL. The user reviews and edits it in Sediment; you cannot approve it through MCP. A revision conflict requires rereading, not forcing the write.

Use one stable `idempotency_key` for retries of the same proposal. Do not reuse it for changed content. Model attribution accepts only model names and generation time, never credentials.
