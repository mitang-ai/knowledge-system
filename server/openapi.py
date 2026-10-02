"""Executable OpenAPI 3.1 contract for the implemented versioned API."""

from copy import deepcopy
from access import FIELDS, SCOPES


def obj(properties, required=(), extra=False):
    return {
        "type": "object",
        "properties": properties,
        "required": list(required),
        "additionalProperties": extra,
    }


def ref(name):
    return {"$ref": "#/components/schemas/" + name}


def array(value, maximum=100):
    return {"type": "array", "items": value, "maxItems": maximum}


def string(maximum=100000):
    return {"type": "string", "maxLength": maximum}


ID = {"type": "string", "minLength": 1, "maxLength": 160}
REV = {"type": "integer", "minimum": 1, "maximum": 2**31}
BOOL = {"type": "boolean"}
SCHEMAS = {
    "Error": obj(
        {
            "schema_version": {"const": "sediment.api.v1"},
            "error": obj(
                {"code": string(80), "message": string(1000)}, ["code", "message"], True
            ),
            "request_id": string(64),
        },
        ["error", "request_id"],
    ),
    "SourceRef": obj(
        {
            "item_id": ID,
            "revision": REV,
            "part_id": ID,
            "relation": {
                "enum": ["supports", "refutes", "revises", "derived_from", "related"]
            },
        },
        ["item_id", "revision"],
    ),
    "Selection": obj(
        {"item_id": ID, "revision": REV, "part_ids": array(ID)}, ["item_id"]
    ),
    "Coverage": obj(
        {
            "complete": BOOL,
            "truncated": BOOL,
            "warnings": array(string(1000), 100),
            "selected_count": {"type": "integer"},
            "returned_count": {"type": "integer"},
            "characters": {"type": "integer"},
        },
        ["complete", "truncated"],
        True,
    ),
    "Fields": array({"enum": sorted(FIELDS)}, 8),
    "Fragment": obj(
        {
            "item_id": ID,
            "space_id": ID,
            "revision": REV,
            "part_id": ID,
            "part_type": string(80),
            "text": string(500000),
            "title": string(500000),
            "citation_id": string(30),
            "author": obj({"id": ID, "display_name": string(500)}),
            "locator": obj({}, extra=True),
            "completeness": {"enum": ["complete", "partial", "missing_original"]},
            "snapshot_sha256": string(64),
            "source_is_public": BOOL,
            "source_url": {"type": ["string", "null"]},
            "historical": BOOL,
        },
        ["item_id", "revision", "part_id", "part_type", "text", "completeness"],
        True,
    ),
    "KnowledgePackage": obj(
        {
            "schema_version": string(80),
            "snapshot_id": string(64),
            "space_id": ID,
            "fields": ref("Fields"),
            "source_refs": array(ref("SourceRef"), 3000),
            "source_heads": array(ref("SourceRef")),
            "fragments": array(ref("Fragment"), 100000),
            "package_sha256": string(64),
            "markdown": string(1000000),
            "coverage": ref("Coverage"),
            "request_id": string(64),
        },
        ["schema_version", "fragments", "coverage"],
        True,
    ),
    "ReadResult": obj(
        {
            "schema_version": string(80),
            "item": obj(
                {
                    "id": ID,
                    "title": string(500000),
                    "type": string(30),
                    "space_id": ID,
                    "revision": REV,
                }
            ),
            "revision": REV,
            "fragments": array(ref("Fragment"), 100000),
            "coverage": ref("Coverage"),
            "request_id": string(64),
        },
        ["item", "revision", "fragments", "coverage"],
        True,
    ),
    "Search": obj(
        {
            "space_id": ID,
            "query": string(2000),
            "fields": ref("Fields"),
            "types": array({"enum": ["note", "topic", "experience", "resource"]}, 4),
            "topic_ids": array(ID),
            "author_ids": array(ID),
            "updated_after": {"type": "string", "format": "date-time"},
            "validation_status": {
                "enum": ["unverified", "supported", "contradicted", "inconclusive"]
            },
            "cursor": string(500),
            "limit": {"type": "integer", "minimum": 1, "maximum": 100},
        }
    ),
    "SearchResult": obj(
        {
            "items": array(
                obj(
                    {
                        "item_id": ID,
                        "title": string(500000),
                        "type": string(30),
                        "space_id": ID,
                        "revision": REV,
                        "snippet": string(220),
                        "matched_part_ids": array(ID, 5),
                    },
                    ["item_id", "revision"],
                    True,
                )
            ),
            "next_cursor": {"type": ["string", "null"]},
            "coverage": ref("Coverage"),
            "request_id": string(64),
        },
        ["items", "coverage"],
        True,
    ),
    "Extraction": obj(
        {
            "space_id": ID,
            "selection": array(ref("Selection")),
            "snapshot_id": ID,
            "citation_ids": array(string(30), 100000),
            "fields": ref("Fields"),
            "purpose": {"enum": ["agent_context", "analysis", "portable_export"]},
            "max_characters": {"type": "integer", "minimum": 1000, "maximum": 100000},
        }
    ),
    "GrantPolicy": obj(
        {
            "name": string(80),
            "space_ids": array(ID, 20),
            "topic_ids": array(ID),
            "item_ids": array(ID),
            "excluded_item_ids": array(ID),
            "fields": ref("Fields"),
            "scopes": array({"enum": sorted(SCOPES)}, 20),
            "dynamic_membership": BOOL,
            "expires_days": {"type": "integer", "minimum": 1, "maximum": 90},
            "allowed_write_actions": array(
                {"enum": ["create_note", "append_reply"]}, 2
            ),
            "max_new_items_per_day": {"type": "integer", "minimum": 1, "maximum": 1000},
        }
    ),
    "Proposal": obj(
        {
            "space_id": ID,
            "action": {
                "enum": [
                    "create_note",
                    "append_reply",
                    "suggest_understanding",
                    "suggest_experience",
                ]
            },
            "target_item_id": ID,
            "base_revision": REV,
            "content": string(),
            "title": string(240),
            "source_refs": array(ref("SourceRef")),
            "model_attribution": obj(
                {
                    "requested_model": string(300),
                    "response_model": string(300),
                    "generated_at": string(300),
                }
            ),
        },
        ["action", "content"],
    ),
    "ExportPlan": obj(
        {
            "space_id": ID,
            "snapshot_id": ID,
            "extraction": ref("Extraction"),
            "destination": {"enum": ["obsidian", "feishu", "ima", "portable"]},
            "target_id": string(500),
            "format": {"enum": ["full_record", "edited_document"]},
            "content": string(),
            "title": string(200),
            "allow_update": BOOL,
        },
        ["destination", "target_id"],
    ),
    "Validation": obj(
        {
            "revision": REV,
            "status": {
                "enum": ["unverified", "supported", "contradicted", "inconclusive"]
            },
            "observation": string(5000),
            "conditions": string(5000),
            "evidence_refs": array(ref("SourceRef"), 30),
        },
        ["revision", "status"],
    ),
    "Lease": obj({"lease": string(200)}, ["lease"]),
    "Receipt": obj(
        {
            "lease": string(200),
            "status": {
                "enum": [
                    "completed",
                    "partial",
                    "failed",
                    "unknown_result",
                    "cancelled",
                ]
            },
            "destination_item_id": string(500),
            "destination_url": string(2000),
            "observed_content_sha256": string(64),
            "read_back_verified": BOOL,
            "stage": string(30),
            "warnings": array(string(500), 20),
        },
        ["lease", "status"],
    ),
    "Rule": obj(
        {
            "grant_id": ID,
            "space_id": ID,
            "fields": ref("Fields"),
            "destination": {"enum": ["obsidian", "feishu", "ima"]},
            "target_id": string(500),
            "max_daily": {"type": "integer", "minimum": 1, "maximum": 100},
            "enabled": BOOL,
            "include_existing": BOOL,
            "allow_update": BOOL,
        },
        ["grant_id", "destination", "target_id"],
    ),
    "TeamPolicy": obj(
        {
            "allow_read": BOOL,
            "allow_export": BOOL,
            "allowed_destinations": array(
                {"enum": ["obsidian", "feishu", "ima", "portable"]}, 4
            ),
        },
        ["allow_read", "allow_export"],
    ),
    "Operation": obj(
        {
            "id": ID,
            "status": string(40),
            "content_sha256": string(64),
            "review_url": string(2000),
            "request_id": string(64),
        },
        ["id"],
        True,
    ),
    "Object": obj({}, extra=True),
}

SCHEMAS["Extraction"]["anyOf"] = [
    {"required": ["selection"]},
    {"required": ["snapshot_id", "citation_ids"]},
]
SCHEMAS["ExportPlan"]["properties"]["model_attribution"] = obj(
    {
        "requested_model": string(300),
        "response_model": string(300),
        "generated_at": string(300),
        "output_status": string(30),
    }
)

# Every public route is listed; interactive controls require cookie sessions (or explicit local UI mode).
ROUTES = [
    ("/capabilities", "get", "发现当前授权", "Object", None, False),
    ("/openapi", "get", "读取接口契约", "Object", None, False),
    ("/search", "post", "搜索已授权知识", "SearchResult", "Search", False),
    ("/items/{id}", "get", "读取当前或指定修订", "ReadResult", None, False),
    ("/items/{id}/segments", "get", "定位稳定段落", "ReadResult", None, False),
    ("/items/{id}/history", "get", "读取有界修订历史", "Object", None, False),
    ("/items/{id}/validation", "post", "保存实践验证", "Object", "Validation", True),
    (
        "/extractions",
        "post",
        "生成确定性知识包",
        "KnowledgePackage",
        "Extraction",
        False,
    ),
    ("/changes", "get", "读取范围内的增量变化", "Object", None, False),
    ("/files/{id}", "get", "读取授权附件原件", None, None, False),
    ("/proposals", "get", "查看可访问建议", "Object", None, False),
    ("/proposals", "post", "提交待采纳建议", "Operation", "Proposal", False),
    ("/proposals/{id}/adopt", "post", "人工编辑并采纳建议", "Object", "Object", True),
    ("/proposals/{id}/reject", "post", "人工拒绝建议", "Operation", "Object", True),
    ("/write", "post", "按显式权限直接写入", "Object", "Proposal", False),
    ("/export-plans", "get", "列出可访问计划", "Object", None, False),
    (
        "/export-plans",
        "post",
        "准备固定目标的外发草案",
        "Operation",
        "ExportPlan",
        False,
    ),
    (
        "/export-plans/{id}/package",
        "get",
        "取得已批准的固定知识包",
        "Object",
        None,
        False,
    ),
    ("/export-plans/{id}/approve", "post", "人工批准稿件", "Operation", "Object", True),
    ("/export-plans/{id}/claim", "post", "独占认领导出任务", "Object", "Object", False),
    (
        "/export-plans/{id}/heartbeat",
        "post",
        "续租与查询取消",
        "Object",
        "Lease",
        False,
    ),
    (
        "/export-plans/{id}/receipts",
        "post",
        "提交本地执行回执",
        "Object",
        "Receipt",
        False,
    ),
    ("/export-plans/{id}/cancel", "post", "请求取消执行", "Operation", "Object", True),
    ("/operations", "get", "查看建议与导出执行", "Object", None, False),
    ("/operations/{id}", "get", "查看单个操作", "Object", None, False),
    ("/jobs", "get", "取得可执行的已批准任务", "Object", None, False),
    ("/grants", "get", "列出自己的授权", "Object", None, True),
    (
        "/grants",
        "post",
        "创建范围授权（只显示一次令牌）",
        "Object",
        "GrantPolicy",
        True,
    ),
    ("/grants/{id}/revoke", "post", "撤销授权", "Object", "Object", True),
    ("/grants/{id}/rotate", "post", "轮换个人访问令牌", "Object", "Object", True),
    ("/policies/{space}", "get", "读取团队外部策略", "Object", None, True),
    ("/policies/{space}", "post", "配置团队外部访问", "Object", "TeamPolicy", True),
    ("/rules", "get", "列出增量规则", "Object", None, True),
    ("/rules", "post", "显式批准固定增量规则", "Object", "Rule", True),
    ("/rules/{id}/toggle", "post", "启用或暂停规则", "Object", "Object", True),
    ("/audit", "get", "读取有界的访问审计", "Object", None, True),
    ("/service-accounts", "get", "列出团队服务账号", "Object", None, True),
    ("/service-accounts", "post", "创建团队服务账号及授权", "Object", "Object", True),
    (
        "/service-accounts/{id}/grant",
        "post",
        "签发服务账号新授权",
        "Object",
        "Object",
        True,
    ),
    (
        "/service-accounts/{id}/disable",
        "post",
        "停用团队服务账号",
        "Object",
        "Object",
        True,
    ),
    ("/oauth/{id}/context", "get", "读取 OAuth 请求", "Object", None, True),
    (
        "/oauth/{id}/consent",
        "post",
        "人工批准或拒绝 OAuth 请求",
        "Object",
        "Object",
        True,
    ),
]


def document(origin):
    paths = {}
    for suffix, method, summary, response, request, interactive in ROUTES:
        operation = {
            "summary": summary,
            "operationId": method
            + "_"
            + suffix.strip("/").replace("/", "_").replace("{", "").replace("}", ""),
            "security": (
                [{"session": []}] if interactive else [{"bearer": []}, {"session": []}]
            ),
            "description": (
                "仅交互用户可调用；Bearer Agent 无法调用此控制操作。"
                if interactive
                else "按当前身份、角色、团队策略和范围检查。"
            ),
            "responses": {
                "200": (
                    {
                        "description": "成功",
                        "content": {"application/json": {"schema": ref(response)}},
                    }
                    if response
                    else {
                        "description": "授权原件",
                        "content": {
                            "application/octet-stream": {
                                "schema": {"type": "string", "format": "binary"}
                            }
                        },
                    }
                ),
                **{
                    str(code): {
                        "description": label,
                        "content": {"application/json": {"schema": ref("Error")}},
                    }
                    for code, label in [
                        (400, "格式无效"),
                        (401, "授权失效"),
                        (403, "权限不足"),
                        (404, "不存在或不可访问"),
                        (409, "版本、游标、幂等或状态冲突"),
                        (429, "超过上限"),
                    ]
                },
            },
        }
        params = []
        for name in ("id", "space"):
            if "{" + name + "}" in suffix:
                params.append(
                    {"name": name, "in": "path", "required": True, "schema": ID}
                )
        if suffix in ("/items/{id}", "/items/{id}/segments", "/items/{id}/history"):
            params.extend(
                [
                    {"name": name, "in": "query", "schema": schema}
                    for name, schema in [
                        ("fields", string(500)),
                        ("revision", REV),
                        ("part_ids", string(20000)),
                    ]
                ]
                if not suffix.endswith("/history")
                else [{"name": "fields", "in": "query", "schema": string(500)}]
            )
        if suffix == "/files/{id}":
            params.extend(
                [
                    {"name": "item_id", "in": "query", "schema": ID},
                    {"name": "revision", "in": "query", "schema": REV},
                ]
            )
        if suffix == "/changes":
            params.extend(
                [
                    {"name": "cursor", "in": "query", "schema": string(500)},
                    {
                        "name": "limit",
                        "in": "query",
                        "schema": {"type": "integer", "minimum": 1, "maximum": 100},
                    },
                ]
            )
        if suffix in ("/audit", "/service-accounts") and method == "get":
            params.append({"name": "space_id", "in": "query", "schema": ID})
        if method == "post" and suffix in ("/proposals", "/write", "/export-plans"):
            params.append(
                {"name": "Idempotency-Key", "in": "header", "schema": string(160)}
            )
        if params:
            operation["parameters"] = params
        if request:
            operation["requestBody"] = {
                "required": True,
                "content": {"application/json": {"schema": ref(request)}},
            }
        paths.setdefault("/api/v1" + suffix, {})[method] = operation
    return {
        "openapi": "3.1.0",
        "info": {
            "title": "沉淀 · 开放知识 API",
            "version": "4.3.0",
            "description": "身份与知识分层接口；不接受浏览器 AI Key 或目的地凭证。",
        },
        "servers": [{"url": origin}],
        "paths": paths,
        "components": {
            "securitySchemes": {
                "bearer": {"type": "http", "scheme": "bearer"},
                "session": {
                    "type": "apiKey",
                    "in": "cookie",
                    "name": "sediment_session",
                },
            },
            "schemas": deepcopy(SCHEMAS),
        },
    }
