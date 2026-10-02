"""User-facing commands. No credentials are accepted in command-line arguments."""

import argparse, json, sys, uuid
from pathlib import Path
from .client import ClientError, origin_url
from .profiles import source, read_profiles, save_profiles, put_secret


def payload(path):
    try:
        value = json.loads(sys.stdin.read() if path == "-" else Path(path).read_text())
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (ValueError, OSError):
        raise ClientError(
            "invalid_input", "输入需为 JSON 对象文件，或 - 从标准输入读取"
        ) from None


def parser():
    p = argparse.ArgumentParser(
        prog="sediment", description="沉淀 · 用户授权的知识接口与本地连接器"
    )
    p.add_argument("--profile", default="default")
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("capabilities")
    q = sub.add_parser("search")
    q.add_argument("query", nargs="?", default="")
    q.add_argument("--space", default="personal")
    q.add_argument("--fields")
    q.add_argument("--cursor")
    q.add_argument("--limit", type=int, default=30)
    q = sub.add_parser("read")
    q.add_argument("item_id")
    q.add_argument("--revision", type=int)
    q.add_argument("--fields")
    q.add_argument("--parts")
    for command in ["extract", "propose", "prepare-export", "write"]:
        q = sub.add_parser(command)
        q.add_argument("file")
        q.add_argument("--idempotency-key")
    q = sub.add_parser("changes")
    q.add_argument("--cursor")
    q.add_argument("--limit", type=int, default=100)
    q = sub.add_parser("operation")
    q.add_argument("id")
    q = sub.add_parser("profile-add")
    q.add_argument("name")
    q.add_argument("--url", required=True)
    q.add_argument(
        "--credential",
        default="env:SEDIMENT_TOKEN",
        help="env:NAME 或 keychain:NAME；不接受明文",
    )
    q = sub.add_parser("keychain-set")
    q.add_argument("name")
    q = sub.add_parser("mcp")
    q.add_argument("--transport", choices=["stdio", "streamable-http"], default="stdio")
    q.add_argument("--url")
    q.add_argument("--resource")
    q.add_argument("--host", default="127.0.0.1")
    q.add_argument("--port", type=int, default=8791)
    q = sub.add_parser("connector")
    s = q.add_subparsers(dest="action", required=True)
    c = s.add_parser("configure")
    c.add_argument("name")
    c.add_argument("file")
    c = s.add_parser("probe")
    c.add_argument("name")
    c = s.add_parser("run")
    c.add_argument("--plan", required=True)
    c.add_argument("--destination", required=True)
    c = s.add_parser("watch")
    c.add_argument("--once", action="store_true")
    c.add_argument("--interval", type=int, default=30)
    c = s.add_parser("reconcile")
    c.add_argument("--plan", required=True)
    c.add_argument("--destination", required=True)
    c = s.add_parser("pull")
    c.add_argument("--plan", required=True)
    c.add_argument("--destination", required=True)
    return p


def main():
    args = parser().parse_args()
    try:
        if args.command == "mcp":
            from .mcp_server import run

            run(args)
            return
        if args.command == "keychain-set":
            put_secret(args.name)
            result = {"ok": True, "credential": "keychain:" + args.name}
        elif args.command == "profile-add":
            if not args.credential.startswith(("env:", "keychain:")):
                raise ClientError("credential_in_profile", "只接受凭证引用")
            profiles = read_profiles()
            profiles["sources"][args.name] = {
                "url": origin_url(args.url),
                "credential": args.credential,
            }
            save_profiles(profiles)
            result = {"ok": True, "profile": args.name}
        elif args.command == "connector":
            from .runner import command

            result = command(args)
        else:
            c = source(args.profile)
            if args.command == "capabilities":
                result = c.capabilities()
            elif args.command == "search":
                result = c.search(
                    args.query,
                    args.space,
                    limit=args.limit,
                    **({"fields": args.fields.split(",")} if args.fields else {}),
                    **({"cursor": args.cursor} if args.cursor else {}),
                )
            elif args.command == "read":
                result = c.read(
                    args.item_id,
                    args.revision,
                    args.fields.split(",") if args.fields else None,
                    args.parts.split(",") if args.parts else None,
                )
            elif args.command == "changes":
                result = c.changes(args.cursor, args.limit)
            elif args.command == "operation":
                result = c.operation(args.id)
            elif args.command == "extract":
                result = c.request("/api/v1/extractions", payload(args.file))
            else:
                endpoint = {
                    "propose": "proposals",
                    "prepare-export": "export-plans",
                    "write": "write",
                }[args.command]
                result = c.request(
                    "/api/v1/" + endpoint,
                    payload(args.file),
                    args.idempotency_key or uuid.uuid4().hex,
                )
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ClientError, KeyboardInterrupt) as e:
        error = {
            "code": getattr(e, "code", "interrupted"),
            "message": str(e) or "已停止",
        }
        if getattr(e, "request_id", None):
            error["request_id"] = e.request_id
        print(json.dumps({"error": error}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
