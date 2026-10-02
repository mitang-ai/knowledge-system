from .base import DestinationError

ALLOWED = {
    "obsidian": {"kind", "target_id", "vault", "folder"},
    "feishu": {
        "kind",
        "target_id",
        "app_id",
        "app_secret",
        "user_token",
        "folder_token",
        "wiki_space",
        "parent_node",
    },
    "ima": {
        "kind",
        "target_id",
        "client_id",
        "api_key",
        "mode",
        "folder_id",
        "knowledge_base_id",
    },
}


def validate(profile):
    if (
        not isinstance(profile, dict)
        or profile.get("kind") not in ALLOWED
        or set(profile) - ALLOWED[profile["kind"]]
    ):
        raise DestinationError("invalid_profile", "目的地配置包含不支持的字段")
    if (
        not isinstance(profile.get("target_id"), str)
        or not 1 <= len(profile["target_id"]) <= 500
    ):
        raise DestinationError("invalid_profile", "目的地需配置与审批相同的 target_id")
    for key in ["app_secret", "user_token", "api_key"]:
        if key in profile and (
            not isinstance(profile[key], str)
            or not profile[key].startswith(("env:", "keychain:"))
        ):
            raise DestinationError(
                "credential_in_profile", "目的地配置只接受 env: 或 keychain: 凭证引用"
            )
    kind = profile["kind"]
    if kind == "obsidian" and not profile.get("vault"):
        raise DestinationError("invalid_profile", "Obsidian 需要明确的本地 vault 路径")
    if (
        kind == "feishu"
        and not profile.get("user_token")
        and not (profile.get("app_id") and profile.get("app_secret"))
    ):
        raise DestinationError(
            "invalid_profile", "飞书需要用户令牌或应用 ID 与 Secret 引用"
        )
    if kind == "ima":
        if (
            not profile.get("client_id")
            or not profile.get("api_key")
            or profile.get("mode", "note") not in ("note", "kb_note", "kb_file")
        ):
            raise DestinationError(
                "invalid_profile", "ima 需要正式 OpenAPI Client ID、Key 引用和目标模式"
            )
        if profile.get("mode") in ("kb_note", "kb_file") and not profile.get(
            "knowledge_base_id"
        ):
            raise DestinationError(
                "invalid_profile", "ima 知识库模式需要 knowledge_base_id"
            )
    return profile


def adapter(profile):
    validate(profile)
    if profile["kind"] == "obsidian":
        from .obsidian import Obsidian

        return Obsidian(profile)
    if profile["kind"] == "feishu":
        from .feishu import Feishu

        return Feishu(profile)
    from .ima import Ima

    return Ima(profile)
