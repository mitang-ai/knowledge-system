"""Deterministic projections: models run in the user's own agent, never in this service."""

import json, re, time, uuid
import kbase
from access import Identity, fail, integer, strings, safe_url, sign_cursor, read_cursor


class KnowledgeService:
    def __init__(self, db, api, identity):
        self.db, self.api, self.identity = db, api, identity

    def candidates(self, space, filters=None):
        filters = filters or {}
        self.identity.require("knowledge:read")
        space = self.identity.space(space)
        result = []
        for row in self.db.execute("SELECT data FROM documents WHERE kind='item'"):
            doc = json.loads(row["data"])
            if (
                doc.get("space_id") or "personal"
            ) != space or not self.identity.visible(doc):
                continue
            if filters.get("types") and doc["type"] not in filters["types"]:
                continue
            if filters.get("topic_ids") and not (
                set(doc.get("topic_ids", [])) & set(filters["topic_ids"])
                or doc["id"] in filters["topic_ids"]
            ):
                continue
            if (
                filters.get("author_ids")
                and doc["owner_id"] not in filters["author_ids"]
            ):
                continue
            if (
                filters.get("updated_after")
                and doc.get("updated_at", "") < filters["updated_after"]
            ):
                continue
            if (
                filters.get("validation_status")
                and (doc.get("validation") or {}).get("status", "unverified")
                != filters["validation_status"]
            ):
                continue
            result.append(doc)
        return result

    def snapshot(self, ident, revision=None):
        self.identity.require("knowledge:read")
        doc = self.identity.document(ident)
        current = kbase.current_revision(self.db, ident)
        if revision is not None:
            integer(revision, "修订号", 1, 2**31)
            if revision != current:
                self.identity.require("history:read")
                self.identity.fields(["history"])
        snapshot = kbase.read_snapshot(self.db, ident, revision)
        if not snapshot:
            fail(404, "not_found", "修订不存在或不可访问")
        return snapshot

    def fragments(self, snapshot, fields, include_history=True):
        fields = self.identity.fields(fields)
        doc, revision = snapshot["item"], snapshot["revision"]
        fragments, warnings = [], []

        def add(part_type, part_id, body, author=None, locator=None, **extra):
            if not isinstance(body, str) or not body.strip():
                return
            fragments.append(
                {
                    "item_id": doc["id"],
                    "space_id": doc.get("space_id") or "personal",
                    "revision": revision,
                    "part_type": part_type,
                    "part_id": part_id,
                    "title": doc.get("title") or "未命名记录",
                    "text": body,
                    "author": {
                        "id": (author or doc).get("owner_id"),
                        "display_name": (author or doc).get("owner_name", ""),
                    },
                    "created_at": (author or doc).get("created_at"),
                    "locator": locator or {"kind": "stable_segment"},
                    "source_url": safe_url(doc.get("source")),
                    "source_is_public": False,
                    "completeness": "complete",
                    "snapshot_sha256": kbase.digest(body),
                    **extra,
                }
            )

        if "original" in fields:
            for block in snapshot["segments"]:
                add(
                    "original_segment",
                    block["id"],
                    block["text"],
                    locator={"kind": "stable_segment", "segment_id": block["id"]},
                    derived_from=block.get("derived_from", []),
                )
        replies = [r for r in snapshot["replies"] if not r.get("deleted_at")]
        if "current_understanding" in fields:
            reply = next((r for r in replies if r["id"] == doc.get("und")), None)
            if reply:
                add(
                    "current_understanding",
                    reply["id"],
                    reply["body"],
                    author=reply,
                    locator={"kind": "reply"},
                    adopted_by=doc["owner_id"],
                )
            elif doc.get("und"):
                warnings.append("该历史快照没有完整的理解来源，未替换为当前文本")
        if "replies" in fields:
            for reply in replies:
                add(
                    "reply",
                    reply["id"],
                    reply["body"],
                    author=reply,
                    locator={"kind": "reply"},
                    is_progress=bool(reply.get("is_progress")),
                )
        if "experience" in fields and doc["type"] == "experience":
            add(
                "experience",
                "experience:" + doc["id"],
                doc.get("body", ""),
                legacy_label=doc.get("exp_st", "需要再确认"),
            )
        if "validation" in fields and (
            doc["type"] == "experience" or doc.get("validation")
        ):
            validation = dict(
                doc.get("validation")
                or {"status": "unverified", "legacy_label": doc.get("exp_st", "")}
            )
            visible_refs = []
            for ref in validation.get("evidence_refs", []):
                try:
                    self.identity.document(ref["item_id"])
                    visible_refs.append(ref)
                except Exception:
                    pass
            validation["evidence_refs"] = visible_refs
            add(
                "validation",
                "validation:" + doc["id"],
                kbase.encoded(validation),
                validation=validation,
            )
        if "provenance" in fields:
            # Never include AI source snapshots from another grant range by accident.
            visible_sources, withheld = [], False
            for source in (doc.get("ai") or {}).get("sources", []):
                ident = source.get("itemId") or source.get("item_id")
                if ident:
                    try:
                        self.identity.document(ident)
                        visible_sources.append(
                            {
                                "item_id": ident,
                                "part_id": source.get("replyId")
                                or source.get("part_id"),
                                "url": safe_url(source.get("url")),
                            }
                        )
                    except Exception:
                        withheld = True
                elif safe_url(source.get("url")):
                    visible_sources.append({"url": safe_url(source.get("url"))})
            if safe_url(doc.get("source")) or visible_sources:
                add(
                    "provenance",
                    "provenance:" + doc["id"],
                    kbase.encoded(
                        {
                            "url": safe_url(doc.get("source")),
                            "sources": visible_sources,
                            "withheld_sources": withheld,
                        }
                    ),
                )
        if "attachment_metadata" in fields:
            attachments = [(a, doc) for a in doc.get("atts", [])] + [
                (a, r) for r in replies for a in r.get("atts", [])
            ]
            seen_attachments = set()
            for att, author in attachments:
                if att["id"] in seen_attachments:
                    continue
                seen_attachments.add(att["id"])
                present = (self.api.STORE / "files" / att["id"]).is_file() and bool(
                    att.get("local")
                )
                add(
                    "attachment_metadata",
                    att["id"],
                    kbase.encoded(
                        {
                            "id": att["id"],
                            "name": att.get("name"),
                            "size": att.get("size"),
                            "mime": att.get("mime"),
                            "available": present,
                        }
                    ),
                    author=author,
                    attachment={
                        "id": att["id"],
                        "name": att.get("name"),
                        "size": att.get("size"),
                        "mime": att.get("mime"),
                        "available": present,
                    },
                    completeness="complete" if present else "missing_original",
                )
        if "history" in fields and include_history:
            historical_fields = [f for f in fields if f != "history"] or [
                f
                for f in (
                    self.identity.policy["fields"]
                    if self.identity.policy
                    else ["original", "current_understanding"]
                )
                if f != "history"
            ]
            revisions = self.db.execute(
                "SELECT revision FROM knowledge_revisions WHERE item_id=? AND revision<? ORDER BY revision DESC LIMIT 21",
                (doc["id"], revision),
            ).fetchall()
            if len(revisions) > 20:
                warnings.append("历史材料仅含最近 20 个旧修订，更多版本可按修订号读取")
            for previous in revisions[:20]:
                fs, ws = self.fragments(
                    kbase.read_snapshot(self.db, doc["id"], previous["revision"]),
                    historical_fields,
                    False,
                )
                for f in fs:
                    f["historical"] = True
                fragments.extend(fs)
                warnings.extend(ws)
        if not snapshot.get("historical_replies_complete", True):
            warnings.append("迁移前的这个版本仅有正文，历史补充快照不可用")
        return fragments, warnings

    def mark_seen(self, ident, revision):
        if self.identity.grant:
            self.db.execute(
                "INSERT OR REPLACE INTO grant_seen VALUES (?,?,?)",
                (self.identity.id, ident, revision),
            )

    def read(self, ident, fields=None, revision=None, parts=None):
        snapshot = self.snapshot(ident, revision)
        selected = self.identity.fields(fields)
        fragments, warnings = self.fragments(snapshot, selected)
        if parts:
            parts = strings(parts, "段落")
            fragments = [f for f in fragments if f["part_id"] in parts]
            if len({f["part_id"] for f in fragments}) != len(parts):
                fail(404, "not_found", "所选段落不存在或未获授权")
        limited, used, truncated = [], 0, False
        for f in fragments:
            available = 100000 - used
            if available <= 0:
                truncated = True
                break
            if len(f["text"]) > available:
                f = {
                    **f,
                    "text": f["text"][:available],
                    "completeness": "partial",
                    "snapshot_sha256": kbase.digest(f["text"][:available]),
                }
                truncated = True
            limited.append(f)
            used += len(f["text"])
        fragments = limited
        for i, f in enumerate(fragments):
            f["citation_id"] = "S" + str(i + 1)
        doc = snapshot["item"]
        self.mark_seen(ident, snapshot["revision"])
        self.identity.audit(
            "knowledge.read", [ident], space=doc.get("space_id") or "personal"
        )
        return {
            "schema_version": "sediment.knowledge-package.v1",
            "item": {
                "id": ident,
                "title": doc.get("title") or "未命名记录",
                "type": doc["type"],
                "space_id": doc.get("space_id") or "personal",
                "revision": snapshot["revision"],
            },
            "fragments": fragments,
            "coverage": {
                "complete": not warnings and not truncated,
                "truncated": truncated,
                "warnings": warnings,
            },
            "revision": snapshot["revision"],
        }

    def history(self, ident, fields=None):
        self.identity.require("history:read")
        self.identity.fields(["history"])
        self.identity.document(ident)
        selected = self.identity.fields(fields)
        revisions = self.db.execute(
            "SELECT revision,at,actor FROM knowledge_revisions WHERE item_id=? ORDER BY revision DESC LIMIT 100",
            (ident,),
        ).fetchall()
        versions, used, truncated = [], 0, False
        for r in revisions:
            fragments, warnings = self.fragments(
                kbase.read_snapshot(self.db, ident, r["revision"]), selected, False
            )
            size = sum(len(f["text"]) for f in fragments)
            if used + size > 100000 and versions:
                truncated = True
                break
            for f in fragments:
                available = max(0, 100000 - used)
                if len(f["text"]) > available:
                    f["text"] = f["text"][:available]
                    f["completeness"] = "partial"
                    f["snapshot_sha256"] = kbase.digest(f["text"])
                    truncated = True
                used += len(f["text"])
            versions.append(
                {
                    "revision": r["revision"],
                    "at": r["at"],
                    "actor": r["actor"],
                    "fragments": fragments,
                    "warnings": warnings,
                }
            )
            if truncated:
                break
        self.identity.audit("knowledge.history", [ident])
        return {
            "versions": versions,
            "coverage": {
                "complete": not truncated and len(revisions) < 100,
                "truncated": truncated or len(revisions) == 100,
            },
        }

    def extract(self, data):
        self.identity.require("knowledge:read")
        space = self.identity.space(data.get("space_id", "personal"))
        if data.get("purpose", "agent_context") == "portable_export":
            self.identity.can_export(space)
        fields = self.identity.fields(data.get("fields"))
        if data.get("snapshot_id"):
            row = self.db.execute(
                "SELECT * FROM knowledge_packages WHERE id=? AND owner=?",
                (data["snapshot_id"], self.identity.actor),
            ).fetchone()
            if not row or self.identity.grant and row["grant_id"] != self.identity.id:
                fail(404, "not_found", "知识包不存在或不可访问")
            previous = json.loads(row["data"])
            self.identity.fields(previous["fields"])
            if previous["space_id"] != space:
                fail(400, "invalid_input", "知识包不属于选定空间")
            for head in previous.get("source_heads", previous["source_refs"]):
                self.identity.document(head["item_id"])
                if kbase.current_revision(self.db, head["item_id"]) != head["revision"]:
                    fail(409, "revision_conflict", "材料已变化，请重新生成知识包")
            citations = strings(data.get("citation_ids"), "片段引用", 100000)
            selected_fragments = [
                f for f in previous["fragments"] if f["citation_id"] in citations
            ]
            if not selected_fragments or set(citations) - {
                f["citation_id"] for f in selected_fragments
            }:
                fail(400, "invalid_input", "选择的片段无效")
            for f in selected_fragments:
                self.snapshot(f["item_id"], f["revision"])
            references = []
            for f in selected_fragments:
                value = {"item_id": f["item_id"], "revision": f["revision"]}
                if value not in references:
                    references.append(value)
            package = {
                **previous,
                "snapshot_id": uuid.uuid4().hex,
                "fragments": selected_fragments,
                "source_refs": references,
                "source_heads": [
                    h
                    for h in previous.get("source_heads", [])
                    if h["item_id"] in {f["item_id"] for f in selected_fragments}
                ],
            }
            package["coverage"] = {
                **package["coverage"],
                "selected_count": len({f["item_id"] for f in selected_fragments}),
                "returned_count": len(selected_fragments),
                "characters": sum(len(f["text"]) for f in selected_fragments),
            }
            package["package_sha256"] = kbase.digest(
                {
                    k: v
                    for k, v in package.items()
                    if k not in ["snapshot_id", "package_sha256", "markdown"]
                }
            )
            package["markdown"] = self.markdown(package)
            self.db.execute(
                "INSERT INTO knowledge_packages VALUES (?,?,?,?,?)",
                (
                    package["snapshot_id"],
                    self.identity.actor,
                    self.identity.grant["id"] if self.identity.grant else None,
                    kbase.encoded(package),
                    kbase.stamp(),
                ),
            )
            self.identity.audit(
                "knowledge.extract", [r["item_id"] for r in references], space=space
            )
            return package
        selection = data.get("selection")
        if not isinstance(selection, list) or not 1 <= len(selection) <= 100:
            fail(400, "invalid_input", "一次选择 1 至 100 条知识")
        budget = integer(data.get("max_characters", 20000), "字符预算", 1000, 100000)
        result, warnings, refs, heads, used, truncated = [], [], [], [], 0, False
        for selection_item in selection:
            if not isinstance(selection_item, dict):
                fail(400, "invalid_input", "条目选择格式无效")
            snapshot = self.snapshot(
                selection_item.get("item_id"), selection_item.get("revision")
            )
            if (snapshot["item"].get("space_id") or "personal") != space:
                fail(404, "not_found", "选择中存在范围外的知识")
            fragments, w = self.fragments(snapshot, fields)
            parts = selection_item.get("part_ids", [])
            if parts:
                parts = strings(parts, "段落")
                fragments = [f for f in fragments if f["part_id"] in parts]
                if set(parts) - {f["part_id"] for f in fragments}:
                    fail(404, "not_found", "选中段落不存在或不可访问")
            warnings.extend(w)
            refs.append(
                {"item_id": snapshot["item"]["id"], "revision": snapshot["revision"]}
            )
            heads.append(
                {
                    "item_id": snapshot["item"]["id"],
                    "revision": kbase.current_revision(self.db, snapshot["item"]["id"]),
                }
            )
            for f in fragments:
                ref = {"item_id": f["item_id"], "revision": f["revision"]}
                if ref not in refs:
                    refs.append(ref)
            self.mark_seen(snapshot["item"]["id"], snapshot["revision"])
            for fragment in fragments:
                available = budget - used
                if available <= 0:
                    truncated = True
                    break
                f = dict(fragment)
                if len(f["text"]) > available:
                    f["text"] = f["text"][:available]
                    f["completeness"] = "partial"
                    f["snapshot_sha256"] = kbase.digest(f["text"])
                    truncated = True
                f["citation_id"] = "S" + str(len(result) + 1)
                result.append(f)
                used += len(f["text"])
        package = {
            "schema_version": "sediment.knowledge-package.v1",
            "snapshot_id": uuid.uuid4().hex,
            "space_id": space,
            "fragments": result,
            "source_refs": refs,
            "source_heads": heads,
            "fields": fields,
            "coverage": {
                "complete": not warnings and not truncated,
                "truncated": truncated,
                "selected_count": len(selection),
                "returned_count": len(result),
                "characters": used,
                "warnings": list(dict.fromkeys(warnings)),
            },
        }
        package["package_sha256"] = kbase.digest(
            {k: v for k, v in package.items() if k != "snapshot_id"}
        )
        package["markdown"] = self.markdown(package)
        self.db.execute(
            "INSERT INTO knowledge_packages VALUES (?,?,?,?,?)",
            (
                package["snapshot_id"],
                self.identity.actor,
                self.identity.grant["id"] if self.identity.grant else None,
                kbase.encoded(package),
                kbase.stamp(),
            ),
        )
        self.identity.audit(
            "knowledge.extract", [r["item_id"] for r in refs], space=space
        )
        return package

    @staticmethod
    def markdown(package):
        labels = {
            "original_segment": "原始记录",
            "current_understanding": "当前理解",
            "reply": "补充与进展",
            "experience": "经验",
            "validation": "验证依据",
            "provenance": "来源",
            "attachment_metadata": "附件",
        }
        lines = [
            "# 知识沉淀",
            "",
            "以下内容保留来源版本；验证状态与个人态度分开记录。",
            "",
        ]
        for f in package["fragments"]:
            lines.extend(
                [
                    "## " + f["title"].replace("\n", " "),
                    "",
                    "### " + labels.get(f["part_type"], f["part_type"]),
                    "",
                    f["text"],
                    "",
                    "["
                    + f["citation_id"]
                    + "] "
                    + f["item_id"]
                    + " @ 修订 "
                    + str(f["revision"])
                    + " / "
                    + f["part_id"]
                    + " / "
                    + (f["author"].get("display_name") or f["author"].get("id") or ""),
                    "",
                ]
            )
        if not package["coverage"]["complete"]:
            lines.extend(["材料说明：内容有截断、缺失或历史来源不全。", ""])
        return "\n".join(lines)

    def search(self, data):
        space = self.identity.space(data.get("space_id", "personal"))
        fields = self.identity.fields(data.get("fields"))
        query = data.get("query", "")
        if not isinstance(query, str) or len(query) > 2000:
            fail(400, "invalid_input", "查询过长")
        limit = integer(data.get("limit", 20), "每页数量", 1, 100)
        filters = {
            k: data.get(k)
            for k in [
                "types",
                "topic_ids",
                "author_ids",
                "updated_after",
                "validation_status",
            ]
        }
        for name in ["types", "topic_ids", "author_ids"]:
            if filters[name] is not None:
                filters[name] = strings(filters[name], name)
        if filters["types"] and set(filters["types"]) - {
            "note",
            "topic",
            "experience",
            "resource",
        }:
            fail(400, "invalid_input", "类型筛选无效")
        if filters["validation_status"] is not None and filters[
            "validation_status"
        ] not in ["unverified", "supported", "contradicted", "inconclusive"]:
            fail(400, "invalid_input", "验证筛选无效")
        if filters["updated_after"] is not None:
            if (
                not isinstance(filters["updated_after"], str)
                or len(filters["updated_after"]) > 50
            ):
                fail(400, "invalid_input", "更新时间格式无效")
            from datetime import datetime

            try:
                datetime.fromisoformat(filters["updated_after"].replace("Z", "+00:00"))
            except ValueError:
                fail(400, "invalid_input", "更新时间请使用 ISO 8601")
        filter_hash = kbase.digest(
            {"space": space, "fields": fields, "query": query, "filters": filters}
        )
        if data.get("cursor"):
            c = read_cursor(
                self.db, self.identity, data["cursor"], "search", filter_hash
            )
            row = self.db.execute(
                "SELECT data FROM knowledge_queries WHERE id=? AND expires>?",
                (c["snapshot"], time.time()),
            ).fetchone()
            if not row:
                fail(409, "cursor_invalid", "搜索快照已过期")
            matches, offset = json.loads(row["data"]), c["offset"]
        else:
            # Filter access before matching/snippets/counts; no global search totals leak.
            tokens = re.findall(r"[\w\u4e00-\u9fff]+", query.lower())
            matches = []
            for doc in self.candidates(space, filters):
                snapshot = kbase.read_snapshot(self.db, doc["id"])
                fragments = self.fragments(snapshot, fields)[0]
                haystack = (
                    (doc.get("title") or "")
                    + "\n"
                    + "\n".join(f["text"] for f in fragments)
                ).lower()
                if tokens and not all(t in haystack for t in tokens):
                    continue
                matching = [
                    f
                    for f in fragments
                    if not tokens or any(t in f["text"].lower() for t in tokens)
                ]
                snippet = (matching[0]["text"] if matching else doc.get("title", ""))[
                    :220
                ]
                matches.append(
                    {
                        "item_id": doc["id"],
                        "title": doc.get("title") or "未命名记录",
                        "type": doc["type"],
                        "space_id": space,
                        "revision": snapshot["revision"],
                        "snippet": snippet,
                        "matched_part_ids": [f["part_id"] for f in matching[:5]],
                        "_sort": doc.get("updated_at", ""),
                    }
                )
            matches.sort(key=lambda r: (r["_sort"], r["item_id"]), reverse=True)
            for m in matches:
                m.pop("_sort")
            c, offset = {"snapshot": uuid.uuid4().hex}, 0
            self.db.execute(
                "INSERT INTO knowledge_queries VALUES (?,?,?)",
                (c["snapshot"], kbase.encoded(matches), time.time() + 900),
            )
            self.db.execute(
                "DELETE FROM knowledge_queries WHERE expires<?", (time.time(),)
            )
        page, changed = [], False
        for match in matches[offset : offset + limit]:
            try:
                self.identity.document(match["item_id"])
                if (
                    kbase.current_revision(self.db, match["item_id"])
                    != match["revision"]
                ):
                    changed = True
                    continue
                self.mark_seen(match["item_id"], match["revision"])
                page.append(match)
            except Exception:
                changed = True
        next_offset = offset + limit
        cursor = (
            sign_cursor(
                self.db,
                self.identity,
                {
                    "kind": "search",
                    "snapshot": c["snapshot"],
                    "offset": next_offset,
                    "filter_hash": filter_hash,
                    "expires": time.time() + 900,
                },
            )
            if next_offset < len(matches)
            else None
        )
        self.identity.audit(
            "knowledge.search", [x["item_id"] for x in page], space=space
        )
        return {
            "items": page,
            "next_cursor": cursor,
            "coverage": {
                "complete": not changed,
                "truncated": False,
                "warnings": (
                    ["分页期间有记录变化，请重新搜索以取得新内容"] if changed else []
                ),
            },
        }

    def changes(self, cursor=None, limit=100):
        self.identity.require("changes:read")
        limit = integer(limit, "每页数量", 1, 100)
        maximum = self.db.execute(
            "SELECT COALESCE(MAX(seq),0) AS n FROM knowledge_events"
        ).fetchone()["n"]
        if cursor:
            c = read_cursor(self.db, self.identity, cursor, "changes")
            start, water = c["after"], c["watermark"]
            if start == water:
                water = maximum
        else:
            start, water = 0, maximum
        allowed = [
            json.loads(r["data"])["id"]
            for r in self.db.execute("SELECT data FROM documents WHERE kind='item'")
            if self.identity.visible(json.loads(r["data"]))
        ]
        events = self.db.execute(
            """SELECT parent_id,MAX(seq) AS seq FROM knowledge_events WHERE seq>? AND seq<=? AND
          (parent_id IN (SELECT value FROM json_each(?)) OR parent_id IN (SELECT item_id FROM grant_seen WHERE grant_id=?))
          GROUP BY parent_id ORDER BY MAX(seq) LIMIT ?""",
            (start, water, kbase.encoded(allowed), self.identity.id, limit + 1),
        ).fetchall()
        has_more = len(events) > limit
        events = events[:limit]
        results = {}
        for event in events:
            ident = event["parent_id"]
            row = self.db.execute(
                "SELECT data FROM documents WHERE id=? AND kind='item'", (ident,)
            ).fetchone()
            doc = json.loads(row["data"]) if row else None
            if doc and self.identity.visible(doc):
                results[ident] = {
                    "item_id": ident,
                    "revision": kbase.current_revision(self.db, ident),
                    "operation": "upsert",
                    "seq": event["seq"],
                }
                self.mark_seen(ident, results[ident]["revision"])
            elif (
                self.identity.grant
                and self.db.execute(
                    "SELECT 1 FROM grant_seen WHERE grant_id=? AND item_id=?",
                    (self.identity.id, ident),
                ).fetchone()
            ):
                results[ident] = {
                    "item_id": ident,
                    "operation": "removed_from_range",
                    "seq": event["seq"],
                }
                self.db.execute(
                    "DELETE FROM grant_seen WHERE grant_id=? AND item_id=?",
                    (self.identity.id, ident),
                )
        after = events[-1]["seq"] if has_more else water
        next_cursor = sign_cursor(
            self.db,
            self.identity,
            {
                "kind": "changes",
                "after": after,
                "watermark": water,
                "expires": time.time() + 86400 * 30,
            },
        )
        self.identity.audit(
            "knowledge.changes", [x["item_id"] for x in results.values()]
        )
        values = []
        for result in results.values():
            value = dict(result)
            value["event_id"] = kbase.digest(
                self.identity.id + ":" + str(value.pop("seq")) + ":" + value["item_id"]
            )[:32]
            values.append(value)
        return {"changes": values, "cursor": next_cursor, "has_more": has_more}

    def validate_experience(self, ident, data):
        doc = self.identity.document(ident)
        self.identity.can_write(doc.get("space_id"))
        if doc["owner_id"] != self.identity.actor:
            fail(403, "scope_required", "只能为自己的经验填写验证依据")
        status = data.get("status")
        if status not in ["unverified", "supported", "contradicted", "inconclusive"]:
            fail(400, "invalid_input", "验证状态无效")
        evidence = data.get("evidence_refs", [])
        if not isinstance(evidence, list) or len(evidence) > 30:
            fail(400, "invalid_input", "验证依据格式无效")
        refs = []
        for ref in evidence:
            if ref.get("relation", "supports") not in [
                "supports",
                "refutes",
                "revises",
                "derived_from",
                "related",
            ]:
                fail(400, "invalid_input", "证据关系无效")
            snapshot = self.snapshot(ref.get("item_id"), ref.get("revision"))
            if ref.get("part_id") not in {
                f["part_id"]
                for f in self.fragments(snapshot, self.identity.fields())[0]
            }:
                fail(404, "not_found", "验证片段不可访问")
            refs.append(
                {
                    "item_id": snapshot["item"]["id"],
                    "revision": snapshot["revision"],
                    "part_id": ref["part_id"],
                    "relation": ref.get("relation", "supports"),
                }
            )
        if (
            status == "supported"
            and not refs
            and not str(data.get("observation", "")).strip()
        ):
            fail(400, "invalid_input", "请记录验证观察或来源依据，不能只改变标签")
        validation = {
            "status": status,
            "evidence_refs": refs,
            "observation": str(data.get("observation", ""))[:5000],
            "conditions": str(data.get("conditions", ""))[:5000],
            "verified_by": self.identity.actor,
            "verified_at": kbase.stamp(),
        }
        if integer(
            data.get("revision"), "修订号", 1, 2**31
        ) != kbase.current_revision(self.db, ident):
            fail(409, "revision_conflict", "知识已变化，请重新核对验证依据")
        doc.pop("revision", None)
        doc["validation"] = validation
        doc["updated_at"] = kbase.stamp()
        self.db.execute(
            "UPDATE documents SET data=? WHERE id=?", (kbase.encoded(doc), ident)
        )
        kbase.project_events(self.db)
        self.identity.audit("knowledge.validation", [ident], space=doc.get("space_id"))
        return {
            "validation": validation,
            "revision": kbase.current_revision(self.db, ident),
        }
