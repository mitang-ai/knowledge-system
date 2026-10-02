#!/usr/bin/env python3
"""Offline bootstrap, never a public HTTP 'first visitor becomes owner' endpoint."""
import argparse, getpass, hashlib, json, os, secrets, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import app

p = argparse.ArgumentParser()
p.add_argument("--email", required=True)
p.add_argument("--name", default="空间所有者")
p.add_argument("--password-file", type=Path)
args = p.parse_args()
app.initialize()
password = (
    args.password_file.read_text().strip()
    if args.password_file
    else getpass.getpass("所有者密码（至少 12 字符，不回显）：")
)
if len(password) < 12:
    raise SystemExit("密码至少 12 字符")
with app.connect() as db:
    if db.execute("SELECT 1 FROM accounts WHERE id=?", (app.OWNER,)).fetchone():
        raise SystemExit("所有者账号已存在；请使用正常账号管理流程")
    salt = secrets.token_hex(16)
    db.execute(
        "INSERT INTO accounts(id,email,password,salt,disabled) VALUES (?,?,?,?,0)",
        (
            app.OWNER,
            args.email.strip().lower(),
            app.password_hash(password, salt),
            salt,
        ),
    )
    db.execute(
        "INSERT OR REPLACE INTO profiles VALUES (?,?)",
        (
            app.OWNER,
            json.dumps(
                {"owner_id": app.OWNER, "display_name": args.name}, ensure_ascii=False
            ),
        ),
    )
print("所有者账号已配置；没有输出密码或会话令牌。")
