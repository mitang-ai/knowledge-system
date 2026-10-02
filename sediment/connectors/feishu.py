"""Official OpenAPI docx + wiki nodes. Updates create versions; never overwrite others."""

import re
from urllib.parse import quote
from .base import Adapter, Http, DestinationError, normalized, sha, render
from ..profiles import secret


class Feishu(Adapter):
    kind = "feishu"
    capabilities = {
        "create": True,
        "read_back": True,
        "update_managed": False,
        "attachments": False,
        "delete": False,
        "wiki": True,
    }

    def __init__(self, profile):
        super().__init__(profile)
        self.http = Http("https://open.feishu.cn")
        if profile.get("user_token"):
            token = secret(profile["user_token"])
        else:
            answer = self.http.request(
                "/open-apis/auth/v3/tenant_access_token/internal",
                {
                    "app_id": profile["app_id"],
                    "app_secret": secret(profile["app_secret"]),
                },
            )
            if answer.get("code") != 0 or not answer.get("tenant_access_token"):
                raise DestinationError("provider_auth", "飞书应用认证失败")
            token = answer["tenant_access_token"]
        self.http.headers = {"Authorization": "Bearer " + token}

    def call(self, path, data=None, method=None, write=False):
        answer = self.http.request("/open-apis/" + path, data, method, write=write)
        if answer.get("code") != 0:
            raise DestinationError(
                "provider_business_error",
                "飞书拒绝了操作，请检查应用权限与目标访问权",
                "apply" if write else "probe",
            )
        value = answer.get("data")
        if not isinstance(value, dict):
            raise DestinationError(
                "provider_protocol",
                "飞书响应不符合预期",
                "apply" if write else "verify",
                uncertain=write,
            )
        return value

    def probe(self):
        if self.profile.get("wiki_space"):
            self.call("wiki/v2/spaces/" + quote(self.profile["wiki_space"], safe=""))
        elif self.profile.get("folder_token"):
            self.call(
                "drive/v1/files?page_size=1&folder_token="
                + quote(self.profile["folder_token"], safe="")
            )
        else:
            self.call("drive/v1/files?page_size=1")
        return {
            "ok": True,
            "kind": self.kind,
            "capabilities": self.capabilities,
            "target_id": self.profile["target_id"],
            "write_permission": "checked_on_apply",
        }

    def plain_lines(self, content):
        # Conservative, lossless text blocks: Markdown source is kept verbatim, including citations.
        lines = []
        for paragraph in content.split("\n"):
            if not paragraph:
                continue
            for index in range(0, len(paragraph), 1800):
                lines.append(paragraph[index : index + 1800])
        return lines or [" "]

    def apply(self, package, previous, journal):
        self.resolve(package)
        journal("before_create", {})
        if self.profile.get("wiki_space"):
            data = {
                "obj_type": "docx",
                "node_type": "origin",
                "title": package["title"],
            }
            if self.profile.get("parent_node"):
                data["parent_node_token"] = self.profile["parent_node"]
            node = self.call(
                "wiki/v2/spaces/"
                + quote(self.profile["wiki_space"], safe="")
                + "/nodes",
                data,
                write=True,
            )["node"]
            doc_id = node["obj_token"]
            node_id = node["node_token"]
        else:
            data = {"title": package["title"]}
            if self.profile.get("folder_token"):
                data["folder_token"] = self.profile["folder_token"]
            doc_id = self.call("docx/v1/documents", data, write=True)["document"][
                "document_id"
            ]
            node_id = None
        result = {
            "id": doc_id,
            "node_id": node_id,
            "previous_destination_id": previous["id"] if previous else None,
            "url": "https://www.feishu.cn/"
            + ("wiki/" + node_id if node_id else "docx/" + doc_id),
        }
        journal("created", result)
        managed = render(package, previous)
        lines = self.plain_lines(managed)
        for start in range(0, len(lines), 50):
            blocks = [
                {
                    "block_type": 2,
                    "text": {"elements": [{"text_run": {"content": line}}]},
                }
                for line in lines[start : start + 50]
            ]
            journal("before_blocks", {**result, "written_lines": start})
            self.call(
                "docx/v1/documents/"
                + quote(doc_id, safe="")
                + "/blocks/"
                + quote(doc_id, safe="")
                + "/children",
                {"children": blocks, "index": -1},
                write=True,
            )
        result["expected_text"] = "\n".join(lines)
        journal("written", result)
        return result

    def read_back(self, result):
        return self.call(
            "docx/v1/documents/" + quote(result["id"], safe="") + "/raw_content"
        ).get("content", "")

    def verify(self, package, result):
        text = self.read_back(result)
        match = normalized(text) == normalized(
            result.get("expected_text", package["content"])
        )
        warnings = (
            ["附件只保留来源标注；飞书连接器当前不上传附件原件"]
            if any(
                f["part_type"] == "attachment_metadata"
                for f in package["package"]["fragments"]
            )
            else []
        )
        if not match:
            warnings.append("目标正文回读与审批稿件不同，请人工核对")
        return {
            "read_back_verified": match,
            "observed_content_sha256": sha(text),
            "warnings": warnings,
        }
