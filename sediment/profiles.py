"""Non-secret local profiles; credentials are env references or OS keychain entries."""

import getpass, json, os, re
from pathlib import Path
from .client import ClientError, Client, origin_url


def root():
    return Path(
        os.environ.get("SEDIMENT_CONFIG_DIR", Path.home() / ".config" / "sediment")
    )


def read_profiles():
    path = root() / "profiles.json"
    if not path.exists():
        return {"sources": {}, "destinations": {}}
    try:
        return json.loads(path.read_text())
    except (ValueError, OSError):
        raise ClientError("profile_invalid", "本地连接配置无法读取") from None


def save_profiles(data):
    folder = root()
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = folder / "profiles.json"
    tmp = folder / "profiles.json.tmp"
    with open(
        tmp, "w", encoding="utf-8", opener=lambda p, f: os.open(p, f, 0o600)
    ) as f:
        f.write(json.dumps(data, ensure_ascii=False, indent=2))
    os.replace(tmp, path)


def secret(reference):
    if not isinstance(reference, str):
        raise ClientError("missing_credential", "凭证需配置环境变量或系统钥匙串引用")
    if reference.startswith("env:"):
        key = reference[4:]
        if not re.fullmatch(r"[A-Z][A-Z0-9_]{1,100}", key):
            raise ClientError("missing_credential", "环境变量名称无效")
        value = os.environ.get(key)
    elif reference.startswith("keychain:"):
        try:
            import keyring

            value = keyring.get_password("sediment", reference[9:])
        except Exception:
            raise ClientError(
                "keychain_unavailable", "系统钥匙串不可用，可改用环境变量引用"
            ) from None
    else:
        raise ClientError("credential_in_profile", "连接文件不能包含明文凭证")
    if not value:
        raise ClientError("missing_credential", "本地凭证未配置或不可用")
    return value


def put_secret(name):
    try:
        import keyring

        value = getpass.getpass("凭证（不回显）：")
        if not value:
            raise ClientError("missing_credential", "凭证为空")
        keyring.set_password("sediment", name, value)
    except ClientError:
        raise
    except Exception:
        raise ClientError(
            "keychain_unavailable", "系统钥匙串不可用；没有写入明文文件"
        ) from None


def source(name="default"):
    profile = read_profiles().get("sources", {}).get(name)
    if not profile:
        return Client(
            os.environ.get("SEDIMENT_URL", "http://127.0.0.1:8787"),
            secret("env:SEDIMENT_TOKEN"),
        )
    return Client(profile["url"], secret(profile["credential"]))
