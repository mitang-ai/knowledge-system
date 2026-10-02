"""Versioned HTTP routes. UI controls require an interactive session, never an agent token."""

import hashlib, json, os, sys, uuid
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs
import kbase
from access import (
    APIError,
    Identity,
    authenticate,
    create_grant,
    public_grant,
    external_policy,
    fail,
    integer,
)
from knowledge import KnowledgeService
from transfers import TransferService, run_rules


def api_origin(api):
    return api.PUBLIC_URL or "http://127.0.0.1:" + os.environ.get(
        "SEDIMENT_PORT", "8787"
    )


def mcp_resource(api):
    return os.environ.get(
        "SEDIMENT_MCP_PUBLIC_URL", "http://127.0.0.1:8791/mcp"
    ).rstrip("/")


def initialize(db):
    db.executescript(
        """
    CREATE TABLE IF NOT EXISTS api_idempotency (
      identity TEXT NOT NULL, action TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL,
      result TEXT NOT NULL, created TEXT NOT NULL, PRIMARY KEY(identity,action,key));
    """
    )


def controls(path):
    return (
        path.startswith("/api/v1/service-accounts")
        or path.startswith("/api/v1/grants")
        or path.startswith("/api/v1/policies")
        or path.startswith("/api/v1/rules")
        or path.startswith("/api/v1/oauth/")
        or path == "/api/v1/audit"
        or path.endswith(("/adopt", "/approve", "/reject", "/cancel", "/validation"))
    )


def handle(handler):
    url = urlparse(handler.path)
    path = url.path.rstrip("/")
    if not path.startswith("/api/v1/"):
        return False
    api = sys.modules[handler.__class__.__module__]
    request_id = uuid.uuid4().hex
    method = handler.command
    identity = None
    try:
        size = int(handler.headers.get("Content-Length", "0"))
        if not 0 <= size <= 2 * 1024 * 1024:
            fail(413, "budget_exceeded", "接口请求不能超过 2 MB")
        data = json.loads(handler.rfile.read(size) or "{}") if method == "POST" else {}
        if not isinstance(data, dict):
            fail(400, "invalid_input", "请求需要 JSON 对象")
        if handler.headers.get("Authorization"):
            secret = handler.headers["Authorization"].removeprefix("Bearer ")
            if len(secret) > 20 and (
                secret in kbase.encoded(data) or secret in handler.path
            ):
                fail(400, "credential_in_content", "内容不能包含访问令牌")
        else:
            # Local UI opts in explicitly. API/SDK clients without a token never become the anonymous owner.
            if (
                not handler.headers.get("Cookie")
                and handler.headers.get("X-Sediment-Interactive") != "1"
            ):
                fail(401, "unauthorized", "Agent 调用需要访问令牌")
            if method == "POST":
                origin = handler.headers.get("Origin")
                expected = api_origin(api)
                development = {
                    "http://127.0.0.1:5173",
                    "http://localhost:5173",
                    "http://127.0.0.1:4173",
                    "http://localhost:4173",
                }
                if origin != expected and (
                    api.PRODUCTION
                    or not origin
                    or urlparse(origin).netloc != handler.headers.get("Host")
                    and origin not in development
                ):
                    fail(403, "origin_rejected", "只接受当前工作空间的请求")
        with api.LOCK, api.connect() as db:
            identity = authenticate(db, api, handler, interactive=controls(path))
            kbase.project_events(db)
            initialize(db)
            count = (
                db.execute(
                    "SELECT COUNT(*) AS n FROM access_audit WHERE grant_id=? AND at>=?",
                    (identity.id, datetime.now(timezone.utc).isoformat()[:16]),
                ).fetchone()["n"]
                if identity.grant
                else 0
            )
            if count >= 120:
                fail(429, "rate_limited", "这个授权的请求过于频繁，请稍后继续")
            service = KnowledgeService(db, api, identity)
            transfer = TransferService(db, api, identity)
            query = parse_qs(url.query)
            idem = handler.headers.get("Idempotency-Key")
            idem_allowed = method == "POST" and path in [
                "/api/v1/proposals",
                "/api/v1/write",
                "/api/v1/export-plans",
            ]
            if idem_allowed and idem:
                if len(idem) > 160:
                    fail(400, "invalid_input", "幂等标识过长")
                old = db.execute(
                    "SELECT * FROM api_idempotency WHERE identity=? AND action=? AND key=?",
                    (identity.id, path, idem),
                ).fetchone()
                if old:
                    if old["hash"] != kbase.digest(data):
                        fail(
                            409, "idempotency_conflict", "同一幂等标识不能用于不同内容"
                        )
                    handler.send(
                        200,
                        {
                            "schema_version": "sediment.api.v1",
                            **json.loads(old["result"]),
                            "request_id": request_id,
                        },
                    )
                    return True
            result = dispatch(
                path, method, data, query, db, api, identity, service, transfer
            )
            if isinstance(result, tuple):
                payload, mime, filename = result
                handler.send(200, payload, mime, filename)
                return True
            if idem_allowed and idem:
                db.execute(
                    "INSERT INTO api_idempotency VALUES (?,?,?,?,?,?)",
                    (
                        identity.id,
                        path,
                        idem,
                        kbase.digest(data),
                        kbase.encoded(result),
                        kbase.stamp(),
                    ),
                )
            kbase.project_events(db)
            # Commit before reporting success; a failed commit must not claim a completed operation.
            db.commit()
            handler.send(
                200,
                (
                    result
                    if path == "/api/v1/openapi"
                    else {
                        "schema_version": "sediment.api.v1",
                        **result,
                        "request_id": request_id,
                    }
                ),
            )
        return True
    except APIError as e:
        if identity:
            with api.LOCK, api.connect() as db:
                Identity(db, api, identity.actor, identity.grant).audit(
                    "api.request.denied", allowed=False, request_id=request_id
                )
        handler.send(
            e.status,
            {
                "schema_version": "sediment.api.v1",
                "error": {"code": e.code, "message": e.message, **e.details},
                "request_id": request_id,
            },
        )
        return True
    except (ValueError, KeyError, TypeError) as e:
        handler.send(
            400,
            {
                "schema_version": "sediment.api.v1",
                "error": {
                    "code": "invalid_input",
                    "message": "请求格式无效，请检查字段与数值范围",
                },
                "request_id": request_id,
            },
        )
        return True
    except Exception:
        handler.send(
            500,
            {
                "schema_version": "sediment.api.v1",
                "error": {
                    "code": "internal_error",
                    "message": "操作未能完成，请凭请求 ID 检查服务日志",
                },
                "request_id": request_id,
            },
        )
        return True


def dispatch(path, method, data, query, db, api, identity, service, transfer):
    tail = path.removeprefix("/api/v1/").split("/")
    get = method == "GET"
    fields = query.get("fields", [""])[0].split(",") if query.get("fields") else None
    if tail[0] == "service-accounts":
        import service_accounts

        return service_accounts.dispatch(db, api, identity, method, data, query, tail)
    if tail[0] == "oauth" and len(tail) == 3:
        import oauth

        if get:
            return oauth.context(db, identity, tail[1])
        if tail[2] == "consent":
            return oauth.consent(db, api, identity, tail[1], data)
    if path == "/api/v1/capabilities" and get:
        expiration = (
            min(identity.grant["expires"], identity.token_info["expires"])
            if identity.token_info
            else identity.grant["expires"] if identity.grant else None
        )
        spaces = (
            identity.policy["space_ids"]
            if identity.policy
            else ["personal"]
            + [
                r["space"]
                for r in db.execute(
                    "SELECT space FROM members WHERE account=?", (identity.actor,)
                )
            ]
        )
        identity.audit("knowledge.capabilities")
        return {
            "schema_version": "sediment.api.v1",
            "subject": identity.actor,
            "grant_id": identity.grant["id"] if identity.grant else None,
            "scopes": sorted(identity.scopes),
            "fields": (
                identity.policy["fields"]
                if identity.policy
                else sorted(__import__("access").FIELDS)
            ),
            "spaces": spaces,
            "client_id": (
                identity.token_info["client_id"]
                if identity.token_info
                else identity.grant["parent_client"] if identity.grant else None
            ),
            "expires_at": (
                int(datetime.fromisoformat(expiration).timestamp())
                if expiration
                else None
            ),
            "resource": (
                identity.grant["audience"] if identity.grant else mcp_resource(api)
            ),
            "mcp_url": mcp_resource(api),
            "api_url": api_origin(api),
            "limits": {
                "page_size": 100,
                "extract_characters": 100000,
                "requests_per_minute": 120,
            },
            "features": [
                "stable_segments",
                "revisions",
                "proposals",
                "approved_export",
                "changes",
                "leases",
                "oauth_pkce",
            ],
        }
    if path == "/api/v1/openapi" and get:
        from openapi import document

        return document(api_origin(api))
    if path == "/api/v1/grants":
        if get:
            return {
                "grants": [
                    public_grant(r)
                    for r in db.execute(
                        "SELECT * FROM access_grants WHERE owner=? ORDER BY created DESC",
                        (identity.actor,),
                    )
                ]
            }
        return create_grant(db, api, identity.actor, data, audience=mcp_resource(api))
    if tail[0] == "grants" and len(tail) == 3 and tail[2] == "rotate" and not get:
        import secrets

        row = db.execute(
            "SELECT * FROM access_grants WHERE id=? AND owner=?",
            (tail[1], identity.actor),
        ).fetchone()
        if not row or not row["enabled"] or row["expires"] <= kbase.stamp():
            fail(404, "not_found", "授权不存在或已失效")
        if row["parent_client"]:
            fail(400, "invalid_input", "OAuth 客户端请撤销后重新授权")
        token = "sd_" + secrets.token_urlsafe(36)
        db.execute(
            "UPDATE access_grants SET token_hash=? WHERE id=?",
            (hashlib.sha256(token.encode()).hexdigest(), row["id"]),
        )
        identity.audit("grant.rotate", [row["id"]])
        return {**public_grant(row), "token": token}
    if tail[0] == "grants" and len(tail) == 3 and tail[2] == "revoke" and not get:
        row = db.execute(
            "SELECT * FROM access_grants WHERE id=? AND owner=?",
            (tail[1], identity.actor),
        ).fetchone()
        if not row:
            fail(404, "not_found", "授权不存在")
        db.execute("UPDATE access_grants SET enabled=0 WHERE id=?", (tail[1],))
        identity.audit("grant.revoke", [tail[1]])
        return {"ok": True}
    if tail[0] == "policies" and len(tail) == 2:
        space = identity.space(tail[1])
        if space == "personal" or api.role_for(db, space, identity.actor) not in [
            "owner",
            "admin",
        ]:
            fail(403, "scope_required", "只有团队管理员可管理外部访问")
        if get:
            return {"space_id": space, **external_policy(db, space)}
        if set(data) - {"allow_read", "allow_export", "allowed_destinations"}:
            fail(400, "invalid_input", "外部策略字段无效")
        for key in ["allow_read", "allow_export"]:
            if not isinstance(data.get(key), bool):
                fail(400, "invalid_input", "请选择外部访问权限")
        destinations = data.get("allowed_destinations", [])
        if not isinstance(destinations, list) or set(destinations) - {
            "ima",
            "feishu",
            "obsidian",
            "portable",
        }:
            fail(400, "invalid_input", "目的地策略无效")
        db.execute(
            "INSERT OR REPLACE INTO team_external_policy VALUES (?,?,?,?)",
            (
                space,
                int(data["allow_read"]),
                int(data["allow_export"]),
                kbase.encoded(destinations),
            ),
        )
        identity.audit("team.external_policy", space=space)
        return {"space_id": space, **external_policy(db, space)}
    if path == "/api/v1/audit" and get:
        space = query.get("space_id", [""])[0]
        if space:
            if api.role_for(db, space, identity.actor) not in ["owner", "admin"]:
                fail(403, "scope_required", "团队审计需要管理员角色")
            rows = db.execute(
                "SELECT * FROM access_audit WHERE space=? ORDER BY at DESC LIMIT 200",
                (space,),
            )
        else:
            rows = db.execute(
                "SELECT * FROM access_audit WHERE owner=? ORDER BY at DESC LIMIT 200",
                (identity.actor,),
            )
        return {"events": [{**dict(r), "refs": json.loads(r["refs"])} for r in rows]}
    if path == "/api/v1/search" and not get:
        return service.search(data)
    if tail[0] == "items" and len(tail) >= 2:
        ident = tail[1]
        if len(tail) == 3 and tail[2] == "validation" and not get:
            return service.validate_experience(ident, data)
        if len(tail) == 3 and tail[2] == "history" and get:
            return service.history(ident, fields)
        if len(tail) == 3 and tail[2] == "segments" and get:
            if fields is None:
                fields = ["original"]
        elif len(tail) != 2 or not get:
            fail(404, "not_found", "接口不存在")
        revision = int(query["revision"][0]) if "revision" in query else None
        parts = query["part_ids"][0].split(",") if "part_ids" in query else None
        return service.read(ident, fields, revision, parts)
    if path == "/api/v1/extractions" and not get:
        return service.extract(data)
    if path == "/api/v1/changes" and get:
        return service.changes(
            query.get("cursor", [None])[0], int(query.get("limit", ["100"])[0])
        )
    if tail[0] == "files" and len(tail) == 2 and get:
        identity.require("attachments:read")
        identity.fields(["attachment_metadata"])
        ident = tail[1]
        if "/" in ident or "\\" in ident or ident in [".", ".."]:
            fail(404, "not_found", "附件不可访问")
        found = False
        if query.get("item_id"):
            snap = service.snapshot(
                query["item_id"][0],
                int(query["revision"][0]) if query.get("revision") else None,
            )
            found = any(
                a.get("id") == ident for a in snap["item"].get("atts", [])
            ) or any(
                not r.get("deleted_at")
                and any(a.get("id") == ident for a in r.get("atts", []))
                for r in snap["replies"]
            )
            if not found:
                fail(404, "not_found", "附件不属于所选知识修订")
        for doc in (
            service.candidates("personal")
            if identity.policy and identity.policy["space_ids"] == ["personal"]
            else [
                json.loads(r["data"])
                for r in db.execute("SELECT data FROM documents WHERE kind='item'")
            ]
        ):
            if not identity.visible(doc):
                continue
            if any(a.get("id") == ident for a in doc.get("atts", [])):
                found = True
                break
            snapshot = kbase.read_snapshot(db, doc["id"])
            if snapshot and any(
                not r.get("deleted_at")
                and any(a.get("id") == ident for a in r.get("atts", []))
                for r in snapshot["replies"]
            ):
                found = True
                break
        file = api.STORE / "files" / ident
        if not found or not file.is_file():
            fail(404, "not_found", "附件原件缺失或不可访问")
        identity.audit("knowledge.attachment", [ident])
        return file.read_bytes(), "application/octet-stream", "attachment-" + ident
    if path == "/api/v1/proposals":
        if get:
            return {"proposals": transfer.list_operations()["proposals"]}
        return transfer.propose(data)
    if path == "/api/v1/write" and not get:
        return transfer.direct_write(data)
    if tail[0] == "proposals" and len(tail) == 3 and not get:
        if tail[2] == "adopt":
            return transfer.adopt(tail[1], data)
        if tail[2] == "reject":
            transfer.proposal(tail[1])
            db.execute(
                "UPDATE knowledge_proposals SET status='rejected',updated=? WHERE id=? AND status='awaiting_approval'",
                (kbase.stamp(), tail[1]),
            )
            return {"id": tail[1], "status": "rejected"}
    if path == "/api/v1/export-plans":
        if get:
            return {"exports": transfer.list_operations()["exports"]}
        return transfer.prepare_export(data)
    if tail[0] == "export-plans" and len(tail) == 3:
        ident, action = tail[1:]
        if get and action == "package":
            return transfer.package(ident)
        if not get:
            if action == "approve":
                return transfer.approve_export(ident, data)
            if action == "claim":
                return transfer.claim(ident, data)
            if action == "heartbeat":
                return transfer.heartbeat(ident, data)
            if action == "receipts":
                return transfer.receipt(ident, data)
            if action == "cancel":
                row, _ = transfer.plan(ident)
                status = (
                    "cancel_requested" if row["status"] == "running" else "cancelled"
                )
                db.execute(
                    "UPDATE export_plans SET status=?,updated=? WHERE id=?",
                    (status, kbase.stamp(), ident),
                )
                return {"id": ident, "status": status}
    if path == "/api/v1/operations" and get:
        return transfer.list_operations()
    if tail[0] == "operations" and len(tail) == 2 and get:
        operations = transfer.list_operations()
        for operation in operations["proposals"] + operations["exports"]:
            if operation["id"] == tail[1]:
                return operation
        fail(404, "not_found", "操作不存在或不可访问")
    if path == "/api/v1/rules":
        if get:
            return {
                "rules": [
                    {
                        **{k: r[k] for k in ["id", "grant_id", "enabled", "created"]},
                        "data": json.loads(r["data"]),
                    }
                    for r in db.execute(
                        "SELECT * FROM export_rules WHERE owner=?", (identity.actor,)
                    )
                ]
            }
        return transfer.create_rule(data)
    if tail[0] == "rules" and len(tail) == 3 and tail[2] == "toggle" and not get:
        row = db.execute(
            "SELECT id FROM export_rules WHERE id=? AND owner=?",
            (tail[1], identity.actor),
        ).fetchone()
        if not row:
            fail(404, "not_found", "规则不存在")
        db.execute(
            "UPDATE export_rules SET enabled=? WHERE id=?",
            (int(data.get("enabled") is True), tail[1]),
        )
        return {"ok": True}
    if path == "/api/v1/jobs" and get:
        identity.require("exports:run")
        run_rules(db, api)
        jobs = []
        for row in db.execute(
            "SELECT id FROM export_plans WHERE owner=? AND status='approved' ORDER BY created LIMIT 100",
            (identity.actor,),
        ):
            try:
                _, payload = transfer.plan(row["id"])
                jobs.append(
                    {
                        "id": row["id"],
                        "destination": payload["destination"],
                        "target_id": payload["target_id"],
                        "title": payload["title"],
                    }
                )
            except APIError:
                pass
        return {"jobs": jobs}
    fail(404, "not_found", "接口不存在")
