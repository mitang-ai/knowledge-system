"""Destination adapter contract and bounded non-redirecting provider transport."""

import hashlib, json, urllib.request, urllib.error
from ..client import ClientError, NoRedirect, origin_url
from ..profiles import secret


def sha(value):
    return hashlib.sha256(
        value.encode() if isinstance(value, str) else value
    ).hexdigest()


def normalized(value):
    return "\n".join(
        line.strip() for line in value.replace("\r", "").splitlines() if line.strip()
    )


class DestinationError(ClientError):
    def __init__(self, code, message, stage="probe", uncertain=False):
        super().__init__(code, message)
        self.stage, self.uncertain = stage, uncertain


class Http:
    def __init__(self, origin, headers=None):
        self.origin = origin_url(origin)
        self.headers = headers or {}
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(
        self, path, data=None, method=None, headers=None, binary=False, write=False
    ):
        if (
            not path.startswith("/")
            or path.startswith("//")
            or ".." in path
            or "\\" in path
        ):
            raise DestinationError("invalid_path", "目的地路径无效")
        h = {**self.headers, **(headers or {})}
        body = (
            data
            if isinstance(data, bytes)
            else (
                json.dumps(data, ensure_ascii=False).encode()
                if data is not None
                else None
            )
        )
        if body is not None and not isinstance(data, bytes):
            h["Content-Type"] = "application/json"
        try:
            with self.opener.open(
                urllib.request.Request(
                    self.origin + path, data=body, headers=h, method=method
                ),
                timeout=45,
            ) as r:
                value = r.read(4 * 1024 * 1024 + 1)
                if len(value) > 4 * 1024 * 1024:
                    raise DestinationError(
                        "budget_exceeded",
                        "目的地响应超过上限",
                        "verify",
                        uncertain=write,
                    )
                return value if binary else json.loads(value)
        except DestinationError:
            raise
        except urllib.error.HTTPError as e:
            # Never include upstream response bodies, headers or credential-bearing URLs in errors.
            raise DestinationError(
                "provider_http_error",
                f"目的地返回 HTTP {e.code}",
                "apply" if write else "probe",
                uncertain=write and (e.code >= 500 or e.code in (408, 429)),
            ) from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            raise DestinationError(
                "provider_result_unknown",
                "无法确认目的地结果，请核对后再处理",
                "apply" if write else "verify",
                uncertain=write,
            ) from None


def render(package, previous=None):
    """Approved text plus mechanically derived, non-secret citation/version metadata."""
    from urllib.parse import quote

    lines = [package["content"], "", "---", "", "沉淀引用索引（需源空间访问权限）"]
    for f in package["package"]["fragments"]:
        label = f"[{f['citation_id']}] {f['item_id']} @ 修订 {f['revision']} / {f['part_id']}"
        if package.get("_source_url"):
            link = (
                package["_source_url"]
                + "/?item="
                + quote(f["item_id"], safe="")
                + "&revision="
                + str(f["revision"])
                + "&part="
                + quote(f["part_id"], safe="")
            )
            lines.append("- " + label + " · " + link)
        else:
            lines.append("- " + label)
    if previous:
        lines.extend(
            ["", "沉淀版本链 · 上一版：" + (previous.get("url") or previous["id"])]
        )
    return "\n".join(lines)


class Adapter:
    kind = ""
    capabilities = {}

    def __init__(self, profile):
        self.profile = profile

    def resolve(self, package):
        if (
            package["destination"] != self.kind
            or package["target_id"] != self.profile["target_id"]
        ):
            raise DestinationError(
                "target_mismatch", "审批目标与本地目的地配置不一致", "resolve"
            )
        return {"destination": self.kind, "target_id": package["target_id"]}

    def plan(self, package, previous=None):
        self.resolve(package)
        return {
            "action": "create_version" if previous else "create",
            "capabilities": self.capabilities,
        }

    def apply(self, package, previous, journal):
        raise NotImplementedError

    def verify(self, package, result):
        raise NotImplementedError

    def read_back(self, result):
        raise NotImplementedError

    def receipt(self, package, result, verification):
        return {
            "status": "completed" if verification["read_back_verified"] else "partial",
            "destination_item_id": result["id"],
            "destination_url": result.get("url"),
            "observed_content_sha256": verification.get("observed_content_sha256", ""),
            "read_back_verified": verification["read_back_verified"],
            "stage": "verify",
            "warnings": verification.get("warnings", []),
        }
