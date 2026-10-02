"""A small typed-origin HTTP client shared by CLI, MCP and connectors."""

import json, os, urllib.request, urllib.error, urllib.parse


class ClientError(Exception):
    def __init__(self, code, message, status=0, request_id=None):
        super().__init__(message)
        self.code, self.status, self.request_id = code, status, request_id


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def origin_url(value, allow_path=False):
    p = urllib.parse.urlparse(value)
    if (
        not p.hostname
        or p.username
        or p.password
        or p.query
        or p.fragment
        or not allow_path
        and p.path not in ("", "/")
    ):
        raise ClientError("invalid_url", "需要不含凭据、查询参数的服务地址")
    if p.scheme != "https" and not (
        p.scheme == "http" and p.hostname in ("127.0.0.1", "localhost", "::1")
    ):
        raise ClientError("invalid_url", "远程连接需要 HTTPS；本机地址可用 HTTP")
    return value.rstrip("/")


class Client:
    def __init__(self, url, token, timeout=30):
        self.url = origin_url(url)
        self.token = token
        self.timeout = timeout
        if not isinstance(token, str) or not token or "\n" in token or "\r" in token:
            raise ClientError("missing_token", "请配置用户授予的访问令牌")
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, path, data=None, idempotency_key=None, binary=False):
        if (
            not path.startswith("/api/v1/")
            or path.startswith("//")
            or ".." in path
            or "\\" in path
            or "#" in path
        ):
            raise ClientError("invalid_path", "SDK 只访问当前实例的版本化知识接口")
        headers = {
            "Authorization": "Bearer " + self.token,
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        request = urllib.request.Request(
            self.url + path,
            headers=headers,
            data=(
                json.dumps(data, ensure_ascii=False).encode()
                if data is not None
                else None
            ),
        )
        try:
            with self.opener.open(request, timeout=self.timeout) as r:
                if int(r.headers.get("Content-Length", "0")) > 25 * 1024 * 1024:
                    raise ClientError("budget_exceeded", "响应超过客户端上限")
                body = r.read(25 * 1024 * 1024 + 1)
                if len(body) > 25 * 1024 * 1024:
                    raise ClientError("budget_exceeded", "响应超过客户端上限")
                return body if binary else json.loads(body)
        except urllib.error.HTTPError as e:
            try:
                value = json.loads(e.read(65536))
                err = value.get("error", {})
                code = (
                    err.get("code", "http_error") if isinstance(err, dict) else str(err)
                )
                message = (
                    err.get("message", "请求失败")
                    if isinstance(err, dict)
                    else value.get("error_description", "请求失败")
                )
            except (ValueError, TypeError):
                value = {}
                code = "http_error"
                message = "请求失败"
            raise ClientError(code, message, e.code, value.get("request_id")) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise ClientError(
                "network_error", "无法确认请求结果，请检查连接；写入操作不要盲目重试"
            ) from None

    def capabilities(self):
        return self.request("/api/v1/capabilities")

    def search(self, query="", space_id="personal", **filters):
        return self.request(
            "/api/v1/search", {"query": query, "space_id": space_id, **filters}
        )

    def read(self, item_id, revision=None, fields=None, part_ids=None):
        q = {}
        if revision is not None:
            q["revision"] = revision
        if fields:
            q["fields"] = ",".join(fields)
        if part_ids:
            q["part_ids"] = ",".join(part_ids)
        path = "/api/v1/items/" + urllib.parse.quote(item_id, safe="")
        return self.request(path + ("?" + urllib.parse.urlencode(q) if q else ""))

    def extract(self, selection, space_id="personal", fields=None, **options):
        return self.request(
            "/api/v1/extractions",
            {
                "selection": selection,
                "space_id": space_id,
                **({"fields": fields} if fields else {}),
                **options,
            },
        )

    def changes(self, cursor=None, limit=100):
        return self.request(
            "/api/v1/changes?"
            + urllib.parse.urlencode(
                {"limit": limit, **({"cursor": cursor} if cursor else {})}
            )
        )

    def propose(self, payload, idempotency_key=None):
        return self.request("/api/v1/proposals", payload, idempotency_key)

    def prepare_export(self, payload, idempotency_key=None):
        return self.request("/api/v1/export-plans", payload, idempotency_key)

    def operation(self, operation_id):
        return self.request(
            "/api/v1/operations/" + urllib.parse.quote(operation_id, safe="")
        )
