"""OAuth 2.1 authorization-code + S256 PKCE, bound to one MCP resource.
Only an interactive user can consent. Tokens and one-use codes are stored hashed.
"""

import base64, hashlib, hmac, json, re, secrets, sys, uuid
from datetime import datetime, timezone, timedelta
from urllib.parse import urlparse, parse_qs, urlencode
import kbase
from access import APIError, SCOPES, Identity, fail, create_grant


def initialize(db):
    db.executescript(
        """
    CREATE TABLE IF NOT EXISTS oauth_clients(id TEXT PRIMARY KEY,name TEXT NOT NULL,redirects TEXT NOT NULL,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_requests(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,data TEXT NOT NULL,expires TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS oauth_codes(code_hash TEXT PRIMARY KEY,client_id TEXT NOT NULL,grant_id TEXT NOT NULL,data TEXT NOT NULL,expires TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS oauth_tokens(token_hash TEXT PRIMARY KEY,client_id TEXT NOT NULL,grant_id TEXT NOT NULL,expires TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_refresh(token_hash TEXT PRIMARY KEY,client_id TEXT NOT NULL,grant_id TEXT NOT NULL,expires TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0);
    """
    )


def hashed(value):
    return hashlib.sha256(value.encode()).hexdigest()


def future(seconds):
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


def redirect_valid(value):
    if not isinstance(value, str) or len(value) > 2000:
        return False
    p = urlparse(value)
    return bool(
        p.hostname
        and not p.username
        and not p.password
        and not p.fragment
        and (
            p.scheme == "https"
            or p.scheme == "http"
            and p.hostname in ("127.0.0.1", "localhost", "::1")
        )
    )


def redirect(handler, url):
    handler.send_response(302)
    handler.send_header("Location", url)
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Referrer-Policy", "no-referrer")
    handler.send_header("Content-Length", "0")
    handler.end_headers()


def add_params(url, values):
    return url + ("&" if urlparse(url).query else "?") + urlencode(values)


def issue(db, client, grant):
    token = "sdo_" + secrets.token_urlsafe(36)
    refresh = "sdr_" + secrets.token_urlsafe(40)
    expiry = min(future(3600), grant["expires"])
    db.execute(
        "INSERT INTO oauth_tokens VALUES (?,?,?,?)",
        (hashed(token), client, grant["id"], expiry),
    )
    db.execute(
        "INSERT INTO oauth_refresh VALUES (?,?,?,?,0)",
        (hashed(refresh), client, grant["id"], grant["expires"]),
    )
    return {
        "access_token": token,
        "token_type": "Bearer",
        "expires_in": max(
            1,
            int(
                (
                    datetime.fromisoformat(expiry) - datetime.now(timezone.utc)
                ).total_seconds()
            ),
        ),
        "refresh_token": refresh,
        "scope": " ".join(json.loads(grant["policy"])["scopes"]),
    }


def live_grant(db, ident, client):
    row = db.execute(
        "SELECT * FROM access_grants WHERE id=? AND parent_client=?", (ident, client)
    ).fetchone()
    if not row or not row["enabled"] or row["expires"] <= kbase.stamp():
        fail(400, "invalid_grant", "授权已失效或被撤销")
    account = db.execute(
        "SELECT disabled FROM accounts WHERE id=?", (row["owner"],)
    ).fetchone()
    if (
        account
        and account["disabled"]
        or not account
        and db.execute("SELECT 1 FROM accounts LIMIT 1").fetchone()
    ):
        fail(400, "invalid_grant", "账号不可用")
    return row


def context(db, identity, ident):
    row = db.execute(
        "SELECT * FROM oauth_requests WHERE id=? AND expires>? AND used=0",
        (ident, kbase.stamp()),
    ).fetchone()
    if not row:
        fail(404, "not_found", "授权请求不存在或已过期")
    client = db.execute(
        "SELECT * FROM oauth_clients WHERE id=?", (row["client_id"],)
    ).fetchone()
    data = json.loads(row["data"])
    return {
        "request_id": ident,
        "client_id": client["id"],
        "client_name": client["name"],
        "redirect_uri": data["redirect_uri"],
        "resource": data["resource"],
        "scopes": data["scope"].split(),
    }


def consent(db, api, identity, ident, data):
    info = context(db, identity, ident)
    request = db.execute("SELECT * FROM oauth_requests WHERE id=?", (ident,)).fetchone()
    params = json.loads(request["data"])
    if data.get("approve") is not True:
        db.execute("UPDATE oauth_requests SET used=1 WHERE id=?", (ident,))
        return {
            "redirect_url": add_params(
                params["redirect_uri"],
                {"error": "access_denied", "state": params["state"]},
            )
        }
    policy = data.get("policy")
    if not isinstance(policy, dict) or set(policy.get("scopes", [])) - set(
        info["scopes"]
    ):
        fail(400, "invalid_scope", "授予的权限必须在请求范围内")
    grant = create_grant(
        db,
        api,
        identity.actor,
        {**policy, "name": info["client_name"]},
        client=info["client_id"],
        audience=info["resource"],
    )
    # Discard the direct token: OAuth clients get only short-lived resource-bound tokens.
    db.execute(
        "UPDATE access_grants SET token_hash=? WHERE id=?",
        (hashed(secrets.token_urlsafe(60)), grant["id"]),
    )
    code = secrets.token_urlsafe(40)
    db.execute(
        "INSERT INTO oauth_codes VALUES (?,?,?,?,?,0)",
        (
            hashed(code),
            info["client_id"],
            grant["id"],
            kbase.encoded(params),
            future(120),
        ),
    )
    db.execute("UPDATE oauth_requests SET used=1 WHERE id=?", (ident,))
    identity.audit("oauth.consent", [grant["id"]])
    return {
        "redirect_url": add_params(
            params["redirect_uri"], {"code": code, "state": params["state"]}
        )
    }


def handle(handler):
    from open_api import api_origin, mcp_resource

    path = urlparse(handler.path).path.rstrip("/")
    if path not in [
        "/.well-known/oauth-authorization-server",
        "/oauth/register",
        "/oauth/authorize",
        "/oauth/token",
        "/oauth/revoke",
    ]:
        return False
    api = sys.modules[handler.__class__.__module__]
    origin, resource = api_origin(api), mcp_resource(api)
    try:
        if (
            path == "/.well-known/oauth-authorization-server"
            and handler.command == "GET"
        ):
            handler.send(
                200,
                {
                    "issuer": origin + "/",
                    "authorization_endpoint": origin + "/oauth/authorize",
                    "token_endpoint": origin + "/oauth/token",
                    "registration_endpoint": origin + "/oauth/register",
                    "revocation_endpoint": origin + "/oauth/revoke",
                    "response_types_supported": ["code"],
                    "grant_types_supported": ["authorization_code", "refresh_token"],
                    "code_challenge_methods_supported": ["S256"],
                    "token_endpoint_auth_methods_supported": ["none"],
                    "scopes_supported": sorted(SCOPES),
                    "client_id_metadata_document_supported": False,
                },
            )
            return True
        with api.LOCK, api.connect() as db:
            size = int(handler.headers.get("Content-Length", "0"))
            if not 0 <= size <= 16384:
                fail(413, "invalid_request", "OAuth 请求过大")
            raw = handler.rfile.read(size) if handler.command == "POST" else b""
            if handler.headers.get("Content-Type", "").startswith("application/json"):
                data = json.loads(raw or "{}")
            else:
                data = {k: v[0] for k, v in parse_qs(raw.decode()).items()}
            if not isinstance(data, dict):
                fail(400, "invalid_request", "OAuth 请求格式无效")
            if path == "/oauth/register" and handler.command == "POST":
                redirects = data.get("redirect_uris", [])
                if (
                    not isinstance(redirects, list)
                    or not 1 <= len(redirects) <= 5
                    or not all(redirect_valid(x) for x in redirects)
                ):
                    fail(
                        400,
                        "invalid_redirect_uri",
                        "回调需要 HTTPS 或本机 loopback 地址",
                    )
                if data.get("token_endpoint_auth_method", "none") != "none":
                    fail(
                        400,
                        "invalid_client_metadata",
                        "此端点仅注册使用 PKCE 的公开客户端",
                    )
                # DCR compatibility is deliberately limited; no secrets, arbitrary scopes or server admin privileges.
                count = db.execute(
                    "SELECT COUNT(*) AS n FROM oauth_clients WHERE created>?",
                    (future(-3600),),
                ).fetchone()["n"]
                if count >= 100:
                    fail(429, "rate_limited", "客户端注册过于频繁")
                client = uuid.uuid4().hex
                name = str(data.get("client_name", "MCP 客户端"))[:80]
                db.execute(
                    "INSERT INTO oauth_clients VALUES (?,?,?,?)",
                    (client, name, kbase.encoded(redirects), kbase.stamp()),
                )
                result = {
                    "client_id": client,
                    "client_name": name,
                    "redirect_uris": redirects,
                    "token_endpoint_auth_method": "none",
                    "grant_types": ["authorization_code", "refresh_token"],
                    "response_types": ["code"],
                }
            elif path == "/oauth/authorize" and handler.command == "GET":
                q = {k: v[0] for k, v in parse_qs(urlparse(handler.path).query).items()}
                client = db.execute(
                    "SELECT * FROM oauth_clients WHERE id=?", (q.get("client_id"),)
                ).fetchone()
                if not client or q.get("redirect_uri") not in json.loads(
                    client["redirects"]
                ):
                    fail(400, "invalid_redirect_uri", "客户端或回调地址无效")
                if (
                    q.get("response_type") != "code"
                    or q.get("code_challenge_method") != "S256"
                    or not re.fullmatch(
                        r"[A-Za-z0-9_-]{43}", q.get("code_challenge", "")
                    )
                ):
                    fail(
                        400,
                        "invalid_request",
                        "授权需要 authorization code 和 S256 PKCE",
                    )
                if q.get("resource") != resource:
                    fail(400, "invalid_target", "资源必须为当前 MCP 的完整地址")
                scopes = q.get("scope", "knowledge:read").split()
                if set(scopes) - SCOPES or "knowledge:read" not in scopes:
                    fail(400, "invalid_scope", "请求的权限无效")
                if len(q.get("state", "")) > 2000:
                    fail(400, "invalid_request", "state 过长")
                ident = uuid.uuid4().hex
                params = {
                    k: q.get(k, "")
                    for k in ["redirect_uri", "code_challenge", "resource", "state"]
                }
                params["scope"] = " ".join(scopes)
                db.execute(
                    "INSERT INTO oauth_requests VALUES (?,?,?,?,0)",
                    (ident, client["id"], kbase.encoded(params), future(600)),
                )
                db.commit()
                redirect(handler, origin + "/?oauth_request=" + ident)
                return True
            elif path == "/oauth/token" and handler.command == "POST":
                client = db.execute(
                    "SELECT * FROM oauth_clients WHERE id=?", (data.get("client_id"),)
                ).fetchone()
                if not client:
                    fail(400, "invalid_client", "客户端无效")
                if data.get("resource") != resource:
                    fail(400, "invalid_target", "资源不匹配")
                if data.get("grant_type") == "authorization_code":
                    code = db.execute(
                        "SELECT * FROM oauth_codes WHERE code_hash=? AND client_id=?",
                        (hashed(str(data.get("code", ""))), client["id"]),
                    ).fetchone()
                    if not code or code["used"] or code["expires"] <= kbase.stamp():
                        fail(400, "invalid_grant", "授权码无效、已使用或过期")
                    params = json.loads(code["data"])
                    verifier = str(data.get("code_verifier", ""))
                    challenge = (
                        base64.urlsafe_b64encode(
                            hashlib.sha256(verifier.encode()).digest()
                        )
                        .decode()
                        .rstrip("=")
                    )
                    if (
                        not re.fullmatch(r"[A-Za-z0-9._~-]{43,128}", verifier)
                        or not hmac.compare_digest(challenge, params["code_challenge"])
                        or data.get("redirect_uri") != params["redirect_uri"]
                        or params["resource"] != resource
                    ):
                        fail(400, "invalid_grant", "PKCE 或回调地址不匹配")
                    grant = live_grant(db, code["grant_id"], client["id"])
                    db.execute(
                        "UPDATE oauth_codes SET used=1 WHERE code_hash=?",
                        (code["code_hash"],),
                    )
                elif data.get("grant_type") == "refresh_token":
                    refresh = db.execute(
                        "SELECT * FROM oauth_refresh WHERE token_hash=? AND client_id=?",
                        (hashed(str(data.get("refresh_token", ""))), client["id"]),
                    ).fetchone()
                    if (
                        not refresh
                        or refresh["used"]
                        or refresh["expires"] <= kbase.stamp()
                    ):
                        fail(400, "invalid_grant", "刷新令牌无效或已轮换")
                    grant = live_grant(db, refresh["grant_id"], client["id"])
                    db.execute(
                        "UPDATE oauth_refresh SET used=1 WHERE token_hash=?",
                        (refresh["token_hash"],),
                    )
                else:
                    fail(400, "unsupported_grant_type", "只支持授权码和刷新令牌")
                result = issue(db, client["id"], grant)
            elif path == "/oauth/revoke" and handler.command == "POST":
                key = hashed(str(data.get("token", "")))
                client = data.get("client_id")
                row = (
                    db.execute(
                        "SELECT grant_id FROM oauth_tokens WHERE token_hash=? AND client_id=?",
                        (key, client),
                    ).fetchone()
                    or db.execute(
                        "SELECT grant_id FROM oauth_refresh WHERE token_hash=? AND client_id=?",
                        (key, client),
                    ).fetchone()
                )
                if row:
                    db.execute(
                        "UPDATE access_grants SET enabled=0 WHERE id=?",
                        (row["grant_id"],),
                    )
                result = {}
            else:
                fail(405, "invalid_request", "请求方法无效")
            db.commit()
            handler.send(200, result)
    except APIError as e:
        handler.send(e.status, {"error": e.code, "error_description": e.message})
    except (ValueError, TypeError, KeyError):
        handler.send(
            400, {"error": "invalid_request", "error_description": "OAuth 请求格式无效"}
        )
    return True
