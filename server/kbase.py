"""Versioned knowledge projections shared by the existing UI, API and agents."""

import difflib, hashlib, json, sqlite3, uuid
from datetime import datetime, timezone


def stamp():
    return datetime.now(timezone.utc).isoformat()


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(
        (value if isinstance(value, str) else encoded(value)).encode()
    ).hexdigest()


def split_blocks(text, prior=None):
    """Preserve identities for unchanged/one-to-one edits; relate split/merged blocks."""
    import re

    parts = [p.strip() for p in re.split(r"\n\s*\n", text or "") if p.strip()]
    old = prior or []
    result = []
    matcher = difflib.SequenceMatcher(
        None, [b["text"] for b in old], parts, autojunk=False
    )
    for operation, a, b, c, d in matcher.get_opcodes():
        if operation == "equal":
            result.extend({**old[a + i], "text": parts[c + i]} for i in range(d - c))
        elif operation == "replace" and b - a == d - c:
            result.extend({**old[a + i], "text": parts[c + i]} for i in range(d - c))
        else:
            ancestors = [x["id"] for x in old[a:b]]
            result.extend(
                {"id": "seg-" + uuid.uuid4().hex, "text": p, "derived_from": ancestors}
                for p in parts[c:d]
            )
    return result


class TrackedConnection(sqlite3.Connection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.actor = None
        self.create_function("sediment_actor", 0, lambda: self.actor)

    def __exit__(self, kind, value, tb):
        if (
            kind is None
            and self.execute(
                "SELECT 1 FROM sqlite_master WHERE name='knowledge_events'"
            ).fetchone()
        ):
            project_events(self)
        return super().__exit__(kind, value, tb)


def initialize(db):
    db.executescript(
        """
    CREATE TABLE IF NOT EXISTS knowledge_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL, parent_id TEXT,
      kind TEXT NOT NULL, operation TEXT NOT NULL, old_data TEXT, new_data TEXT,
      actor TEXT, at TEXT NOT NULL, projected INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS knowledge_revisions (
      item_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot TEXT NOT NULL,
      hash TEXT NOT NULL, at TEXT NOT NULL, actor TEXT, PRIMARY KEY(item_id,revision));
    CREATE TABLE IF NOT EXISTS knowledge_heads (
      item_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, seq INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS knowledge_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS knowledge_queries (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS knowledge_cursors (id TEXT PRIMARY KEY, identity TEXT NOT NULL, data TEXT NOT NULL, expires REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS knowledge_packages (id TEXT PRIMARY KEY, owner TEXT NOT NULL, grant_id TEXT, data TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rule_runs (id TEXT PRIMARY KEY, created TEXT NOT NULL);
    INSERT OR IGNORE INTO knowledge_settings VALUES ('policy_generation','1');
    CREATE TABLE IF NOT EXISTS access_grants (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
      policy TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, expires TEXT NOT NULL,
      created TEXT NOT NULL, last_used TEXT, parent_client TEXT, audience TEXT);
    CREATE TABLE IF NOT EXISTS grant_seen (
      grant_id TEXT NOT NULL, item_id TEXT NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY(grant_id,item_id));
    CREATE TABLE IF NOT EXISTS access_audit (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, grant_id TEXT, space TEXT,
      action TEXT NOT NULL, allowed INTEGER NOT NULL, refs TEXT NOT NULL,
      at TEXT NOT NULL, request_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS knowledge_proposals (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, grant_id TEXT, space TEXT, payload TEXT NOT NULL,
      status TEXT NOT NULL, approved_hash TEXT, approved_by TEXT, created TEXT NOT NULL,
      updated TEXT NOT NULL, result TEXT);
    CREATE TABLE IF NOT EXISTS export_plans (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, grant_id TEXT, space TEXT NOT NULL,
      data TEXT NOT NULL, status TEXT NOT NULL, approved_hash TEXT, created TEXT NOT NULL,
      updated TEXT NOT NULL, lease_hash TEXT, lease_until TEXT, executor TEXT, result TEXT);
    CREATE TABLE IF NOT EXISTS export_rules (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, grant_id TEXT NOT NULL, data TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS team_external_policy (
      space TEXT PRIMARY KEY, allow_read INTEGER NOT NULL DEFAULT 0,
      allow_export INTEGER NOT NULL DEFAULT 0, allowed_destinations TEXT NOT NULL DEFAULT '[]');
    CREATE TRIGGER IF NOT EXISTS knowledge_insert AFTER INSERT ON documents BEGIN
      INSERT INTO knowledge_events(doc_id,parent_id,kind,operation,new_data,actor,at)
      VALUES (NEW.id,CASE WHEN NEW.kind='reply' THEN json_extract(NEW.data,'$.item_id') ELSE NEW.id END,
      NEW.kind,'upsert',NEW.data,sediment_actor(),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_update AFTER UPDATE OF data ON documents WHEN NEW.data != OLD.data BEGIN
      INSERT INTO knowledge_events(doc_id,parent_id,kind,operation,old_data,new_data,actor,at)
      VALUES (NEW.id,CASE WHEN NEW.kind='reply' THEN json_extract(NEW.data,'$.item_id') ELSE NEW.id END,
      NEW.kind,'upsert',OLD.data,NEW.data,sediment_actor(),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_delete AFTER DELETE ON documents BEGIN
      INSERT INTO knowledge_events(doc_id,parent_id,kind,operation,old_data,actor,at)
      VALUES (OLD.id,CASE WHEN OLD.kind='reply' THEN json_extract(OLD.data,'$.item_id') ELSE OLD.id END,
      OLD.kind,'delete',OLD.data,sediment_actor(),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    END;
    """
    )
    for table in ["members", "team_external_policy"]:
        for operation in ["INSERT", "UPDATE", "DELETE"]:
            db.execute(
                f"""CREATE TRIGGER IF NOT EXISTS policy_{table}_{operation} AFTER {operation} ON {table}
              BEGIN UPDATE knowledge_settings SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='policy_generation'; END"""
            )
    db.execute(
        """CREATE TRIGGER IF NOT EXISTS policy_account_disabled AFTER UPDATE OF disabled ON accounts
      BEGIN UPDATE knowledge_settings SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='policy_generation'; END"""
    )
    if not db.execute(
        "SELECT 1 FROM knowledge_settings WHERE key='projections_initialized'"
    ).fetchone():
        items = [
            json.loads(r["data"])
            for r in db.execute("SELECT data FROM documents WHERE kind='item'")
        ]
        replies = [
            json.loads(r["data"])
            for r in db.execute("SELECT data FROM documents WHERE kind='reply'")
        ]
        for item in items:
            # Old item versions have no reliable historical reply snapshots: label that honestly.
            for previous in db.execute(
                "SELECT at,data FROM versions WHERE item_id=? ORDER BY at,rowid",
                (item["id"],),
            ).fetchall():
                try:
                    write_revision(
                        db,
                        item["id"],
                        {
                            "item": json.loads(previous["data"]),
                            "replies": [],
                            "historical_replies_complete": False,
                        },
                        0,
                        previous["at"],
                        None,
                    )
                except (ValueError, KeyError, TypeError):
                    continue
            write_revision(
                db,
                item["id"],
                {
                    "item": item,
                    "replies": [r for r in replies if r["item_id"] == item["id"]],
                    "historical_replies_complete": True,
                },
                0,
                stamp(),
                None,
            )
            event = db.execute(
                "INSERT INTO knowledge_events(doc_id,parent_id,kind,operation,new_data,at,projected) VALUES (?,?,'item','upsert',?,?,1)",
                (item["id"], item["id"], encoded(item), stamp()),
            )
            db.execute(
                "UPDATE knowledge_heads SET seq=? WHERE item_id=?",
                (event.lastrowid, item["id"]),
            )
        db.execute(
            "INSERT INTO knowledge_settings VALUES ('projections_initialized','1')"
        )
        # Initial imports have already been projected as a complete migration snapshot.
        db.execute("UPDATE knowledge_events SET projected=1")


def current_revision(db, ident):
    row = db.execute(
        "SELECT revision FROM knowledge_heads WHERE item_id=?", (ident,)
    ).fetchone()
    return row["revision"] if row else 0


def read_snapshot(db, ident, revision=None):
    if revision is None:
        revision = current_revision(db, ident)
    row = db.execute(
        "SELECT * FROM knowledge_revisions WHERE item_id=? AND revision=?",
        (ident, revision),
    ).fetchone()
    return (
        {
            **json.loads(row["snapshot"]),
            "revision": row["revision"],
            "at": row["at"],
            "actor": row["actor"],
        }
        if row
        else None
    )


def write_revision(db, ident, snapshot, seq, at, actor):
    previous = read_snapshot(db, ident)
    if previous and digest({k: snapshot[k] for k in ["item", "replies"]}) == digest(
        {k: previous[k] for k in ["item", "replies"]}
    ):
        db.execute("UPDATE knowledge_heads SET seq=? WHERE item_id=?", (seq, ident))
        return
    snapshot = dict(snapshot)
    snapshot["segments"] = split_blocks(
        snapshot["item"].get("body", ""), previous.get("segments") if previous else None
    )
    revision = current_revision(db, ident) + 1
    db.execute(
        "INSERT INTO knowledge_revisions VALUES (?,?,?,?,?,?)",
        (ident, revision, encoded(snapshot), digest(snapshot), at, actor),
    )
    db.execute(
        "INSERT OR REPLACE INTO knowledge_heads VALUES (?,?,?)", (ident, revision, seq)
    )


def project_events(db):
    events = db.execute(
        "SELECT * FROM knowledge_events WHERE projected=0 ORDER BY seq"
    ).fetchall()
    for event in events:
        ident = event["parent_id"]
        prior = read_snapshot(db, ident)
        if event["kind"] == "item":
            value = json.loads(event["new_data"] or event["old_data"])
            if event["operation"] == "delete":
                value = {**value, "deleted_at": event["at"], "_purged": True}
            snapshot = {
                "item": value,
                "replies": prior["replies"] if prior else [],
                "historical_replies_complete": True,
            }
        elif prior:
            value = json.loads(event["new_data"] or event["old_data"])
            replies = [r for r in prior["replies"] if r["id"] != event["doc_id"]]
            if event["operation"] != "delete":
                replies.append(value)
            snapshot = {
                "item": prior["item"],
                "replies": replies,
                "historical_replies_complete": True,
            }
        else:
            snapshot = None
        if snapshot:
            write_revision(
                db, ident, snapshot, event["seq"], event["at"], event["actor"]
            )
        db.execute(
            "UPDATE knowledge_events SET projected=1 WHERE seq=?", (event["seq"],)
        )
