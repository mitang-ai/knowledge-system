"""Explicit vault folder only; no symlink escape, atomic writes, compare-before-update."""

import json, os, re, tempfile
from pathlib import Path
from .base import Adapter, DestinationError, sha, render


class Obsidian(Adapter):
    kind = "obsidian"
    capabilities = {
        "create": True,
        "read_back": True,
        "update_managed": True,
        "attachments": True,
        "delete": False,
        "wiki": False,
    }

    def folder(self):
        raw = Path(self.profile["vault"]).expanduser().absolute()
        if not raw.is_dir():
            raise DestinationError(
                "vault_missing", "请选择已存在的 Obsidian 仓库", "resolve"
            )
        # Reject symlinks in both the selected vault and descendants used by the connector.
        if any(p.is_symlink() for p in [raw, *raw.parents]):
            raise DestinationError("unsafe_path", "仓库路径不能经过符号链接", "resolve")
        relative = Path(self.profile.get("folder", "沉淀"))
        if (
            relative.is_absolute()
            or ".." in relative.parts
            or not relative.parts
            or "\\" in str(relative)
        ):
            raise DestinationError(
                "unsafe_path", "沉淀目录需为仓库内的普通相对路径", "resolve"
            )
        current = raw
        for part in relative.parts:
            if part in ("", "."):
                continue
            current = current / part
            if current.is_symlink():
                raise DestinationError(
                    "unsafe_path", "沉淀目录不能使用符号链接", "resolve"
                )
            current.mkdir(exist_ok=True)
            if not current.is_dir():
                raise DestinationError("unsafe_path", "沉淀路径不是目录", "resolve")
        return current

    def probe(self):
        folder = self.folder()
        return {
            "ok": os.access(folder, os.W_OK),
            "capabilities": self.capabilities,
            "target_id": self.profile["target_id"],
            "kind": self.kind,
        }

    def safe_file(self, name):
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]+\.md", name):
            raise DestinationError("unsafe_path", "托管笔记文件名无效", "resolve")
        path = self.folder() / name
        if path.is_symlink():
            raise DestinationError("unsafe_path", "托管笔记不能使用符号链接", "resolve")
        return path

    def plan(self, package, previous=None):
        self.resolve(package)
        self.folder()
        action = (
            "update_managed"
            if previous and package.get("allow_update")
            else "create_version" if previous else "create"
        )
        if action == "update_managed":
            path = self.safe_file(previous["id"])
            if not path.exists() or sha(path.read_bytes()) != previous["file_sha256"]:
                raise DestinationError(
                    "destination_conflict",
                    "Obsidian 内容已在外部编辑；请保留本地修改并创建新版本",
                    "plan",
                )
        return {"action": action, "capabilities": self.capabilities}

    def atomic(self, path, body, expected=None):
        if path.is_symlink():
            raise DestinationError("unsafe_path", "目标文件是符号链接", "apply")
        if path.exists() and (expected is None or sha(path.read_bytes()) != expected):
            raise DestinationError(
                "destination_conflict", "目标文件已存在或已变化", "apply"
            )
        handle, name = tempfile.mkstemp(prefix=".sediment-", dir=path.parent)
        try:
            os.fchmod(handle, 0o600)
            with os.fdopen(handle, "wb") as f:
                f.write(body)
                f.flush()
                os.fsync(f.fileno())
            if path.exists() and (
                expected is None or sha(path.read_bytes()) != expected
            ):
                raise DestinationError(
                    "destination_conflict", "保存前目标文件发生变化", "apply"
                )
            if expected is None:
                # Hard-link gives exclusive creation; no check/replace race for new files.
                os.link(name, path)
                os.unlink(name)
            else:
                os.replace(name, path)
        except FileExistsError:
            raise DestinationError(
                "destination_conflict", "同名文件已经存在", "apply"
            ) from None
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def apply(self, package, previous, journal):
        decision = self.plan(package, previous)
        refs = package["package"]["source_refs"]
        name = (
            previous["id"]
            if decision["action"] == "update_managed"
            else "sediment-" + package["plan_id"] + ".md"
        )
        path = self.safe_file(name)
        properties = {
            "sediment_managed": True,
            "sediment_previous_destination": previous["id"] if previous else None,
            "sediment_plan": package["plan_id"],
            "sediment_source": refs,
            "sediment_content_sha256": package["content_sha256"],
            "sediment_snapshot": package["package"]["snapshot_id"],
            "tags": ["沉淀"],
        }
        front = (
            "---\n"
            + "".join(
                key + ": " + json.dumps(value, ensure_ascii=False) + "\n"
                for key, value in properties.items()
            )
            + "---\n\n"
        )
        attachment_text = ""
        if package.get("_attachments"):
            attachments = self.folder() / "attachments"
            if attachments.is_symlink():
                raise DestinationError(
                    "unsafe_path", "附件目录不能使用符号链接", "apply"
                )
            attachments.mkdir(exist_ok=True)
            for a in package["_attachments"]:
                if not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", a["id"]):
                    raise DestinationError("unsafe_path", "附件 ID 无效", "apply")
                extension = Path(a["name"]).suffix.lower()
                if not re.fullmatch(r"\.[a-z0-9]{1,12}", extension):
                    extension = ".bin"
                target = attachments / (a["id"] + extension)
                if target.is_symlink():
                    raise DestinationError("unsafe_path", "附件目标是符号链接", "apply")
                if target.exists():
                    if sha(target.read_bytes()) != sha(a["bytes"]):
                        raise DestinationError(
                            "destination_conflict", "托管附件内容发生变化", "apply"
                        )
                else:
                    self.atomic(target, a["bytes"])
                attachment_text += (
                    "\n- ["
                    + a["name"]
                    .replace("[", "")
                    .replace("]", "")
                    .replace("\n", " ")
                    .replace("\r", " ")
                    + "](attachments/"
                    + target.name
                    + ")"
                )
        body = (
            front
            + render(package, previous)
            + ("\n\n## 附件原件\n" + attachment_text if attachment_text else "")
            + "\n"
        ).encode()
        journal("before_write", {"id": name})
        self.atomic(
            path,
            body,
            (
                previous.get("file_sha256")
                if decision["action"] == "update_managed"
                else None
            ),
        )
        result = {
            "id": name,
            "file_sha256": sha(body),
            "expected_text": package["content"],
            "attachment_count": len(package.get("_attachments", [])),
        }
        journal("written", result)
        return result

    def read_back(self, result):
        return self.safe_file(result["id"]).read_text()

    def verify(self, package, result):
        content = self.read_back(result)
        match = sha(content.encode()) == result["file_sha256"]
        return {
            "read_back_verified": match,
            "observed_content_sha256": sha(content),
            "warnings": [] if match else ["目标文件与本次托管内容不一致"],
        }
