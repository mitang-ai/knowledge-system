---
name: sediment-deposit-knowledge
description: Prepare a cited, version-bound knowledge document for a user's Obsidian vault, Feishu documents/wiki or ima notes/knowledge base, with explicit approval and durable receipts.
---

1. Discover scopes with `knowledge_capabilities`. `knowledge:export` is required for a Sediment export plan. Readable plaintext can still be copied by a third party; do not claim that a no-export scope is a technical copy-prevention guarantee.
2. Retrieve the selected materials with `knowledge_extract`, `purpose=portable_export`. Preserve citations and incomplete-material warnings. Use the exact destination kind and target ID the user selected; never choose the first same-name destination.
3. Prepare `knowledge_prepare_export` with `snapshot_id`, `space_id`, `destination`, `target_id`, `format`, content and title. `full_record` preserves materials; `edited_document` contains the reviewed draft. The resulting plan is awaiting approval.
4. Give the user the review URL. They confirm fixed text, sources and target in the interface, or they have already preauthorized a fixed full-record incremental rule. An Agent cannot approve its own plan.
5. Execute only an approved package through the user's configured local connector or destination tools. Platform credentials stay local; never submit them to Sediment. The local runner checks targets and leases and journals writes.
6. Inspect the receipt with `knowledge_operation`. `runner_reported` means the local runner reported verification; it is not independent server verification. Do not call a task completed merely because it was queued.

```sh
sediment connector probe LOCAL_PROFILE
sediment connector run --plan PLAN_ID --destination LOCAL_PROFILE
sediment operation PLAN_ID
sediment connector reconcile --plan PLAN_ID --destination LOCAL_PROFILE
```

Obsidian may update unchanged managed notes when explicitly approved. External edits produce a conflict. Feishu and ima create new versions; they do not overwrite or delete earlier documents. Missing attachment-upload capabilities must be stated. On an unknown write result, reconcile or ask the user to check the destination; never blindly repeat creation.
