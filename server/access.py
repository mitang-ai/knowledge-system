"""Scoped agent identities. No AI or destination credentials are stored here."""

import base64, hashlib, hmac, json, secrets, time, uuid
from datetime import datetime, timezone, timedelta
from urllib.parse import urlparse, urlunparse
import kbase

SCOPES = {
    "knowledge:read",
    "history:read",
    "attachments:read",
    "changes:read",
    "proposals:create",
    "knowledge:export",
    "exports:run",
    "knowledge:write",
}
FIELDS = {
    "original",
    "current_understanding",
    "replies",
    "experience",
    "validation",
    "provenance",
    "history",
    "attachment_metadata",
}
DEFAULT_FIELDS = [
    "original",
    "current_understanding",
    "experience",
    "validation",
    "provenance",
]


class APIError(Exception):
    def __init__(self, status, code, message, **details):
        super().__init__(message)
        self.status, self.code, self.message, self.details = (
            status,
            code,
            message,
            details,
        )


def fail(status, code, message, **details):
    raise APIError(status, code, message, **details)


def text(value, name, maximum=100000):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        fail(400, "invalid_input", name + "格式无效或过长")
    return value.strip()


def strings(value, name, maximum=100):
    if (
        not isinstance(value, list)
        or len(value) > maximum
        or any(not isinstance(x, str) or not x or len(x) > 160 for x in value)
    ):
        fail(400, "invalid_input", name + "必须是有限的 ID 列表")
    return list(dict.fromkeys(value))


def integer(value, name, minimum, maximum):
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not minimum <= value <= maximum
    ):
        fail(400, "invalid_input", name + "超出范围")
    return value


def safe_url(value):
    """Public source URL, never a private credential-bearing or temporary URL."""
    if not isinstance(value, str):
        return None
    url = urlparse(value)
    if (
        url.scheme not in ("http", "https")
        or not url.hostname
        or url.username
        or url.password
    ):
        return None
    return urlunparse((url.scheme, url.netloc, url.path, "", "", ""))


def external_policy(db, space):
    row = db.execute(
        "SELECT * FROM team_external_policy WHERE space=?", (space,)
    ).fetchone()
    return (
        {
            "allow_read": bool(row["allow_read"]),
            "allow_export": bool(row["allow_export"]),
            "allowed_destinations": json.loads(row["allowed_destinations"]),
        }
        if row
        else {"allow_read": False, "allow_export": False, "allowed_destinations": []}
    )


class Identity:
    def __init__(self, db, api, actor, grant=None, token_info=None):
        self.db, self.api, self.actor, self.grant, self.token_info = (
            db,
            api,
            actor,
            grant,
            token_info,
        )
        self.policy = json.loads(grant["policy"]) if grant else None
        self.scopes = set(self.policy["scopes"]) if grant else SCOPES.copy()
        self.id = grant["id"] if grant else "interactive:" + actor

    def require(self, scope):
        if scope not in self.scopes:
            fail(
                403,
                "scope_required",
                "当前授权没有这项操作权限",
                required_scopes=[scope],
            )

    def fields(self, requested=None):
        result = (
            requested
            if requested is not None
            else (self.policy["fields"] if self.policy else DEFAULT_FIELDS)
        )
        if not isinstance(result, list) or not result or set(result) - FIELDS:
            fail(400, "invalid_input", "请选择有效的内容层次")
        if self.policy and set(result) - set(self.policy["fields"]):
            fail(403, "scope_required", "请求包含未授权的内容层次")
        if "history" in result:
            self.require("history:read")
        if "attachment_metadata" in result:
            self.require("attachments:read")
        return list(dict.fromkeys(result))

    def visible(self, doc):
        if doc.get("deleted_at") or not self.api.visible(self.db, doc, self.actor):
            return False
        space = doc.get("space_id") or "personal"
        if self.policy:
            p = self.policy
            if space not in p["space_ids"] or doc["id"] in p["excluded_item_ids"]:
                return False
            if not p["dynamic_membership"] and doc["id"] not in p["captured_item_ids"]:
                return False
            if p["item_ids"] and doc["id"] not in p["item_ids"]:
                return False
            if p["topic_ids"] and not (
                set(doc.get("topic_ids", [])) & set(p["topic_ids"])
                or doc["id"] in p["topic_ids"]
            ):
                return False
            if (
                doc.get("space_id")
                and not external_policy(self.db, doc["space_id"])["allow_read"]
            ):
                return False
        return True

    def document(self, ident):
        row = self.db.execute(
            "SELECT data FROM documents WHERE id=? AND kind='item'", (ident,)
        ).fetchone()
        doc = json.loads(row["data"]) if row else None
        if not doc or not self.visible(doc):
            fail(404, "not_found", "知识不存在或不在当前授权范围")
        return doc

    def space(self, space):
        space = space or "personal"
        if not isinstance(space, str) or len(space) > 160:
            fail(400, "invalid_input", "空间 ID 无效")
        if self.policy and space not in self.policy["space_ids"]:
            fail(403, "scope_required", "空间不在当前授权范围")
        if space != "personal" and not self.api.role_for(self.db, space, self.actor):
            fail(404, "not_found", "空间不存在或不可访问")
        return space

    def can_write(self, space):
        space = self.space(space)
        if space != "personal" and self.api.role_for(
            self.db, space, self.actor
        ) not in ("owner", "admin", "editor"):
            fail(403, "scope_required", "当前团队角色只允许阅读")

    def can_export(self, space, destination=None):
        self.require("knowledge:export")
        self.space(space)
        if space != "personal":
            policy = external_policy(self.db, space)
            if (
                not policy["allow_export"]
                or destination
                and destination not in policy["allowed_destinations"]
            ):
                fail(403, "scope_required", "团队尚未允许向这个目的地沉淀内容")

    def audit(self, action, refs=None, allowed=True, space=None, request_id=None):
        self.db.execute(
            "INSERT INTO access_audit VALUES (?,?,?,?,?,?,?,?,?)",
            (
                uuid.uuid4().hex,
                self.actor,
                self.grant["id"] if self.grant else None,
                space,
                action,
                int(allowed),
                kbase.encoded(refs or []),
                kbase.stamp(),
                request_id or uuid.uuid4().hex,
            ),
        )


def authenticate(db, api, handler, interactive=False):
    authorization = handler.headers.get("Authorization", "")
    if authorization:
        if interactive:
            fail(
                403,
                "interactive_required",
                "这个操作需要用户在界面确认，Agent 不能自行批准",
            )
        if not authorization.startswith("Bearer ") or len(authorization) > 1000:
            fail(401, "unauthorized", "访问令牌无效")
        key = hashlib.sha256(authorization[7:].encode()).hexdigest()
        grant = db.execute(
            "SELECT * FROM access_grants WHERE token_hash=?", (key,)
        ).fetchone()
        token_info = None
        if (
            not grant
            and db.execute(
                "SELECT 1 FROM sqlite_master WHERE name='oauth_tokens'"
            ).fetchone()
        ):
            token_info = db.execute(
                "SELECT * FROM oauth_tokens WHERE token_hash=? AND expires>?",
                (key, kbase.stamp()),
            ).fetchone()
            if token_info:
                grant = db.execute(
                    "SELECT * FROM access_grants WHERE id=?", (token_info["grant_id"],)
                ).fetchone()
        if not grant or not grant["enabled"] or grant["expires"] <= kbase.stamp():
            fail(401, "unauthorized", "访问令牌已失效或被撤销")
        account = db.execute(
            "SELECT disabled FROM accounts WHERE id=?", (grant["owner"],)
        ).fetchone()
        # Local grants remain usable only on this account-less local instance; never become OWNER by fallback.
        if (
            account
            and account["disabled"]
            or not account
            and db.execute("SELECT 1 FROM accounts LIMIT 1").fetchone()
        ):
            fail(401, "unauthorized", "授权账号不可用")
        db.execute(
            "UPDATE access_grants SET last_used=? WHERE id=?",
            (kbase.stamp(), grant["id"]),
        )
        db.actor = grant["owner"]
        return Identity(db, api, grant["owner"], grant, token_info)
    actor = handler.identity(db)
    if not actor:
        fail(401, "unauthorized", "请登录或提供有效的访问令牌")
    db.actor = actor
    return Identity(db, api, actor)


def validate_policy(db, api, actor, data):
    if not isinstance(data, dict):
        fail(400, "invalid_input", "授权配置无效")
    allowed = {
        "name",
        "space_ids",
        "topic_ids",
        "item_ids",
        "excluded_item_ids",
        "fields",
        "scopes",
        "dynamic_membership",
        "expires_days",
        "allowed_write_actions",
        "max_new_items_per_day",
    }
    if set(data) - allowed:
        fail(400, "invalid_input", "授权只接受范围与权限配置，不接受凭据")
    identity = Identity(db, api, actor)
    spaces = strings(data.get("space_ids", ["personal"]), "空间", 20)
    if not spaces:
        fail(400, "invalid_input", "至少选择一个空间")
    for space in spaces:
        identity.space(space)
        if space != "personal" and not external_policy(db, space)["allow_read"]:
            fail(403, "scope_required", "团队管理员需先允许外部 Agent 访问")
    topics = strings(data.get("topic_ids", []), "主题")
    items = strings(data.get("item_ids", []), "条目")
    excluded = strings(data.get("excluded_item_ids", []), "排除项")
    for ident in topics + items + excluded:
        doc = identity.document(ident)
        if (doc.get("space_id") or "personal") not in spaces:
            fail(400, "invalid_input", "条目和主题必须属于选定空间")
        if ident in topics and doc.get("type") != "topic":
            fail(400, "invalid_input", "选择的主题无效")
    fields = identity.fields(data.get("fields", DEFAULT_FIELDS))
    scopes = strings(data.get("scopes", ["knowledge:read"]), "操作权限", 20)
    if set(scopes) - SCOPES or "knowledge:read" not in scopes:
        fail(400, "invalid_input", "操作权限无效")
    if (
        "history" in fields
        and "history:read" not in scopes
        or "attachment_metadata" in fields
        and "attachments:read" not in scopes
    ):
        fail(400, "invalid_input", "历史与附件需要对应的独立权限")
    dynamic = data.get("dynamic_membership", False)
    if not isinstance(dynamic, bool):
        fail(400, "invalid_input", "未来新增内容授权必须显式选择")
    candidates = [
        json.loads(r["data"])
        for r in db.execute("SELECT data FROM documents WHERE kind='item'")
    ]
    captured = [
        d["id"]
        for d in candidates
        if identity.visible(d)
        and (d.get("space_id") or "personal") in spaces
        and (not items or d["id"] in items)
        and (
            not topics or set(d.get("topic_ids", [])) & set(topics) or d["id"] in topics
        )
        and d["id"] not in excluded
    ]
    actions = strings(
        data.get("allowed_write_actions", ["create_note", "append_reply"]),
        "写入动作",
        10,
    )
    if set(actions) - {"create_note", "append_reply"}:
        fail(400, "invalid_input", "直接写入只支持新记录和补充")
    return {
        "space_ids": spaces,
        "topic_ids": topics,
        "item_ids": items,
        "excluded_item_ids": excluded,
        "fields": fields,
        "scopes": scopes,
        "dynamic_membership": dynamic,
        "captured_item_ids": captured,
        "allowed_write_actions": actions,
        "max_new_items_per_day": integer(
            data.get("max_new_items_per_day", 10), "每日写入上限", 1, 1000
        ),
    }


def create_grant(db, api, actor, data, client=None, audience=None):
    policy = validate_policy(db, api, actor, data)
    name = text(data.get("name", "我的 Agent"), "名称", 80)
    days = integer(data.get("expires_days", 30), "有效天数", 1, 90)
    token = "sd_" + secrets.token_urlsafe(36)
    ident = uuid.uuid4().hex
    expires = (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()
    db.execute(
        "INSERT INTO access_grants(id,owner,name,token_hash,policy,expires,created,parent_client,audience) VALUES (?,?,?,?,?,?,?,?,?)",
        (
            ident,
            actor,
            name,
            hashlib.sha256(token.encode()).hexdigest(),
            kbase.encoded(policy),
            expires,
            kbase.stamp(),
            client,
            audience,
        ),
    )
    return {
        "id": ident,
        "name": name,
        "token": token,
        "policy": policy,
        "expires": expires,
    }


def public_grant(row):
    return {
        k: row[k]
        for k in [
            "id",
            "name",
            "enabled",
            "expires",
            "created",
            "last_used",
            "parent_client",
        ]
    } | {"policy": json.loads(row["policy"])}


def cursor_secret(db):
    row = db.execute(
        "SELECT value FROM knowledge_settings WHERE key='cursor_secret'"
    ).fetchone()
    if row:
        return row["value"]
    value = secrets.token_hex(32)
    db.execute("INSERT INTO knowledge_settings VALUES ('cursor_secret',?)", (value,))
    return value


def cursor_policy(db, identity):
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
    return kbase.digest(
        {
            "actor": identity.actor,
            "grant": identity.policy,
            "spaces": [
                {
                    "id": space,
                    "role": identity.api.role_for(db, space, identity.actor),
                    "external": external_policy(db, space),
                }
                for space in sorted(spaces)
                if space != "personal"
            ],
        }
    )


def sign_cursor(db, identity, data):
    # Opaque handles keep global sequence watermarks and filter metadata private.
    payload = {**data, "policy": cursor_policy(db, identity)}
    ident = secrets.token_urlsafe(24)
    db.execute(
        "INSERT INTO knowledge_cursors VALUES (?,?,?,?)",
        (ident, identity.id, kbase.encoded(payload), data["expires"]),
    )
    db.execute("DELETE FROM knowledge_cursors WHERE expires<?", (time.time(),))
    signature = hmac.new(
        cursor_secret(db).encode(), ident.encode(), hashlib.sha256
    ).hexdigest()
    return ident + "." + signature


def read_cursor(db, identity, value, kind, filter_hash=None):
    try:
        ident, signature = value.split(".")
        if len(value) > 500 or not hmac.compare_digest(
            signature,
            hmac.new(
                cursor_secret(db).encode(), ident.encode(), hashlib.sha256
            ).hexdigest(),
        ):
            raise ValueError()
        row = db.execute(
            "SELECT data FROM knowledge_cursors WHERE id=? AND identity=? AND expires>?",
            (ident, identity.id, time.time()),
        ).fetchone()
        if not row:
            raise ValueError()
        data = json.loads(row["data"])
        generation = cursor_policy(db, identity)
        if (
            data.get("policy") != generation
            or data.get("kind") != kind
            or filter_hash
            and data.get("filter_hash") != filter_hash
        ):
            raise ValueError()
        if data.get("expires", 0) < time.time():
            raise ValueError()
        return data
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        fail(409, "cursor_invalid", "分页范围已失效，请在当前授权下重新开始")
