"""Team-scoped automation subjects, without login sessions or platform privileges."""

import hashlib, json, secrets, uuid
import kbase
from access import Identity, create_grant, fail, text, public_grant


def initialize(db):
    db.execute(
        "CREATE TABLE IF NOT EXISTS service_accounts(id TEXT PRIMARY KEY,space TEXT NOT NULL,manager TEXT NOT NULL,name TEXT NOT NULL,created TEXT NOT NULL)"
    )


def dispatch(db, api, identity, method, data, query, tail):
    initialize(db)
    if not db.execute(
        "SELECT 1 FROM accounts WHERE id=?", (identity.actor,)
    ).fetchone():
        fail(
            409, "account_required", "请先在账号与空间启用个人登录，再创建团队服务账号"
        )
    space = data.get("space_id") or query.get("space_id", [""])[0]
    if len(tail) == 3:
        row = db.execute(
            "SELECT * FROM service_accounts WHERE id=?", (tail[1],)
        ).fetchone()
        if not row:
            fail(404, "not_found", "服务账号不存在")
        space = row["space"]
    if (
        not space
        or space == "personal"
        or api.role_for(db, space, identity.actor) not in ("owner", "admin")
    ):
        fail(403, "scope_required", "服务账号由团队管理员管理")
    if len(tail) == 3 and tail[2] == "disable":
        db.execute("UPDATE accounts SET disabled=1 WHERE id=?", (row["id"],))
        db.execute("DELETE FROM members WHERE account=?", (row["id"],))
        db.execute("UPDATE access_grants SET enabled=0 WHERE owner=?", (row["id"],))
        identity.audit("service_account.disable", [row["id"]], space=space)
        return {"ok": True}
    if method == "GET":
        return {
            "accounts": [
                {
                    **dict(r),
                    "grants": [
                        public_grant(g)
                        for g in db.execute(
                            "SELECT * FROM access_grants WHERE owner=?", (r["id"],)
                        )
                    ],
                }
                for r in db.execute(
                    "SELECT * FROM service_accounts WHERE space=?", (space,)
                )
            ]
        }
    if len(tail) == 3 and tail[2] == "grant":
        if not api.role_for(db, space, row["id"]):
            fail(403, "scope_required", "服务账号已停用")
        account = row["id"]
    else:
        name = text(data.get("name"), "服务账号名称", 80)
        account = "service-" + uuid.uuid4().hex
        salt = secrets.token_hex(16)
        # No known password can log this subject in; tokens are its only entry point.
        db.execute(
            "INSERT INTO accounts(id,email,password,salt,disabled) VALUES (?,?,?,?,0)",
            (
                account,
                account + "@automation.invalid",
                api.password_hash(secrets.token_urlsafe(80), salt),
                salt,
            ),
        )
        db.execute(
            "INSERT INTO members VALUES (?,?,?)",
            (space, account, "editor" if data.get("role") == "editor" else "viewer"),
        )
        db.execute(
            "INSERT INTO profiles VALUES (?,?)",
            (
                account,
                kbase.encoded(
                    {"owner_id": account, "display_name": name, "service_account": True}
                ),
            ),
        )
        db.execute(
            "INSERT INTO service_accounts VALUES (?,?,?,?,?)",
            (account, space, identity.actor, name, kbase.stamp()),
        )
    policy = data.get("policy")
    if not isinstance(policy, dict):
        fail(400, "invalid_input", "请配置服务账号的访问范围")
    if policy.get("space_ids") != [space]:
        fail(400, "invalid_input", "服务账号授权只能属于它的团队")
    grant = create_grant(
        db, api, account, policy, audience=__import__("open_api").mcp_resource(api)
    )
    identity.audit("service_account.grant", [account, grant["id"]], space=space)
    return {"account_id": account, **grant}
