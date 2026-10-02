"""IMA formal OpenAPI: note import, KB note linking and Markdown COS ingestion.
No cookies and no assumption of replace/delete capabilities.
"""

import hashlib, hmac, re, time
from urllib.parse import quote, urlparse
from .base import Adapter, Http, DestinationError, normalized, sha, render
from ..profiles import secret


class Ima(Adapter):
    kind = "ima"
    capabilities = {
        "create": True,
        "append": False,
        "read_back": True,
        "update_managed": False,
        "attachments": False,
        "delete": False,
        "wiki": True,
        "file_upload": True,
    }

    def __init__(self, profile):
        super().__init__(profile)
        self.http = Http(
            "https://ima.qq.com",
            {
                "ima-openapi-clientid": profile["client_id"],
                "ima-openapi-apikey": secret(profile["api_key"]),
            },
        )

    def call(self, kind, action, data, write=False):
        answer = self.http.request(
            "/openapi/" + kind + "/v1/" + action, data, write=write
        )
        if answer.get("code") not in (0, "0") or isinstance(answer.get("code"), bool):
            raise DestinationError(
                "provider_business_error",
                "ima 拒绝了操作，请检查 OpenAPI 权限与目标",
                "apply" if write else "probe",
            )
        if not isinstance(answer.get("data"), dict):
            raise DestinationError(
                "provider_protocol",
                "ima 响应格式无效",
                "apply" if write else "verify",
                uncertain=write,
            )
        return answer["data"]

    def probe(self):
        if self.profile.get("knowledge_base_id"):
            self.call(
                "wiki",
                "get_knowledge_base",
                {"ids": [self.profile["knowledge_base_id"]]},
            )
        else:
            self.call("note", "list_notebook", {"cursor": "0", "limit": 1})
        return {
            "ok": True,
            "kind": self.kind,
            "capabilities": self.capabilities,
            "target_id": self.profile["target_id"],
            "write_permission": "checked_on_apply",
        }

    def cos_upload(self, credential, body):
        required = [
            "token",
            "secret_id",
            "secret_key",
            "start_time",
            "expired_time",
            "bucket_name",
            "region",
            "cos_key",
        ]
        if not isinstance(credential, dict) or any(
            k not in credential for k in required
        ):
            raise DestinationError(
                "provider_protocol", "COS 临时凭证字段缺失", "upload"
            )
        start, end = int(credential["start_time"]), int(credential["expired_time"])
        if start > time.time() + 60 or end <= time.time() + 30 or end - start > 86400:
            raise DestinationError(
                "credential_expired", "COS 临时凭证已失效或有效期异常", "upload"
            )
        bucket, region, key = (
            credential["bucket_name"],
            credential["region"],
            credential["cos_key"],
        )
        if (
            not re.fullmatch(r"[a-z0-9-]+-[0-9]+", bucket)
            or not re.fullmatch(r"[a-z0-9-]+", region)
            or not isinstance(key, str)
            or not key
            or ".." in key.split("/")
            or any(x in key for x in "\r\n\\")
        ):
            raise DestinationError("provider_protocol", "COS 目标无效", "upload")
        host = f"{bucket}.cos.{region}.myqcloud.com"
        path = "/" + quote(key.lstrip("/"), safe="/~")
        key_time = f"{start};{end}"
        sign_key = hmac.new(
            credential["secret_key"].encode(), key_time.encode(), hashlib.sha1
        ).hexdigest()
        # Sign only Host; security-token and content-type are sent but are not in q-header-list.
        http_string = "put\n" + path + "\n\nhost=" + quote(host, safe="") + "\n"
        string_to_sign = (
            "sha1\n"
            + key_time
            + "\n"
            + hashlib.sha1(http_string.encode()).hexdigest()
            + "\n"
        )
        signature = hmac.new(
            sign_key.encode(), string_to_sign.encode(), hashlib.sha1
        ).hexdigest()
        authorization = (
            "q-sign-algorithm=sha1&q-ak="
            + quote(credential["secret_id"], safe="")
            + "&q-sign-time="
            + key_time
            + "&q-key-time="
            + key_time
            + "&q-header-list=host&q-url-param-list=&q-signature="
            + signature
        )
        Http("https://" + host).request(
            path,
            body,
            method="PUT",
            headers={
                "Authorization": authorization,
                "Host": host,
                "x-cos-security-token": credential["token"],
                "Content-Type": "text/markdown",
                "Content-Length": str(len(body)),
            },
            binary=True,
            write=True,
        )

    def apply(self, package, previous, journal):
        self.resolve(package)
        journal("before_create", {})
        mode = self.profile.get("mode", "note")
        managed = render(package, previous)
        if mode == "kb_file":
            body = managed.encode()
            filename = "sediment-" + package["plan_id"] + ".md"
            kb = self.profile["knowledge_base_id"]
            duplicate = self.call(
                "wiki",
                "check_repeated_names",
                {
                    "knowledge_base_id": kb,
                    "folder_id": self.profile.get("folder_id", ""),
                    "params": [{"name": filename, "media_type": 7}],
                },
            )
            if any(x.get("is_repeated") for x in duplicate.get("results", [])):
                raise DestinationError(
                    "destination_conflict", "ima 中已存在同名托管文件，请先核对", "plan"
                )
            media = self.call(
                "wiki",
                "create_media",
                {
                    "file_name": filename,
                    "file_size": len(body),
                    "file_ext": "md",
                    "content_type": "text/markdown",
                    "knowledge_base_id": kb,
                },
                write=True,
            )
            result = {
                "id": media["media_id"],
                "media_id": media["media_id"],
                "mode": mode,
            }
            journal("created", result)
            self.cos_upload(media["cos_credential"], body)
            journal("uploaded", result)
            data = {
                "media_type": 7,
                "media_id": media["media_id"],
                "title": filename,
                "knowledge_base_id": kb,
                "file_info": {
                    "cos_key": media["cos_credential"]["cos_key"],
                    "file_size": len(body),
                    "file_name": filename,
                    "last_modify_time": int(time.time()),
                },
            }
            if self.profile.get("folder_id"):
                data["folder_id"] = self.profile["folder_id"]
            added = self.call("wiki", "add_knowledge", data, write=True)
            result["id"] = added["media_id"]
            result["linked"] = True
        else:
            data = {"content_format": 1, "content": managed}
            if self.profile.get("folder_id") and mode == "note":
                data["folder_id"] = self.profile["folder_id"]
            note = self.call("note", "import_doc", data, write=True)
            result = {
                "id": str(note["note_id"]),
                "note_id": str(note["note_id"]),
                "mode": mode,
            }
            journal("created", result)
            if mode == "kb_note":
                data = {
                    "media_type": 11,
                    "title": package["title"],
                    "knowledge_base_id": self.profile["knowledge_base_id"],
                    "note_info": {"content_id": result["note_id"]},
                }
                if self.profile.get("folder_id"):
                    data["folder_id"] = self.profile["folder_id"]
                media = self.call("wiki", "add_knowledge", data, write=True)
                result["media_id"] = media["media_id"]
                result["id"] = media["media_id"]
                result["linked"] = True
        result["expected_text"] = managed
        result["previous_destination_id"] = previous["id"] if previous else None
        journal("written", result)
        return result

    def read_back(self, result):
        if result.get("note_id"):
            return self.call(
                "note",
                "get_doc_content",
                {"note_id": result["note_id"], "target_content_format": 0},
            ).get("content", "")
        media = self.call("wiki", "get_media_info", {"media_id": result["media_id"]})
        url_info = media.get("url_info")
        if not url_info:
            raise DestinationError(
                "read_back_unavailable", "ima 暂未提供该文件的原文回读", "verify"
            )
        p = urlparse(url_info.get("url", ""))
        if (
            p.scheme != "https"
            or p.username
            or p.password
            or p.port not in (None, 443)
            or not p.hostname
            or not (
                p.hostname in ("ima.qq.com", "res-skb.ima.qq.com")
                or p.hostname.endswith(".myqcloud.com")
            )
        ):
            raise DestinationError(
                "unsafe_media_url", "ima 返回的原文地址不在已支持的资源域名中", "verify"
            )
        # Temporary media headers never reuse the long-term IMA API key.
        headers = url_info.get("headers", {})
        if not isinstance(headers, dict) or any(
            not isinstance(v, str) or "\n" in v or "\r" in v for v in headers.values()
        ):
            raise DestinationError("provider_protocol", "原文临时请求头无效", "verify")
        return (
            Http("https://" + p.netloc, headers)
            .request(p.path + ("?" + p.query if p.query else ""), binary=True)
            .decode("utf-8")
        )

    def verify(self, package, result):
        if result.get("mode") in ("kb_note", "kb_file") and not result.get("linked"):
            return {
                "read_back_verified": False,
                "warnings": [
                    "创建或上传已记录，但目标知识库入库未确认；请在目的地核对，不会重复创建"
                ],
            }
        try:
            text = self.read_back(result)
        except DestinationError as e:
            if e.code == "read_back_unavailable":
                return {"read_back_verified": False, "warnings": [str(e)]}
            raise
        match = normalized(text) == normalized(
            result.get("expected_text", package["content"])
        )
        warnings = [] if match else ["ima 原文回读与审批稿件不同，请人工核对"]
        if any(
            f["part_type"] == "attachment_metadata"
            for f in package["package"]["fragments"]
        ):
            warnings.append("附件只保留来源标注；ima 连接器不单独上传附件原件")
        return {
            "read_back_verified": match,
            "observed_content_sha256": sha(text),
            "warnings": warnings,
        }
