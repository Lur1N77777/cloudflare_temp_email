#!/usr/bin/env python3
"""Render worker/wrangler.toml for GitHub Actions deployment.

This keeps sensitive values optional. If JWT/admin/site passwords are already
configured on the existing Worker, `keep_vars = true` lets Cloudflare preserve
those values during deploy. Explicit secrets can still be provided to override.
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def parse_json_array(name: str, default: list[Any] | None = None) -> list[Any]:
    raw = env(name)
    if not raw:
        return default or []
    try:
        value = json.loads(raw)
        if isinstance(value, list):
            return value
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"{name} 必须是 JSON 数组，当前值解析失败: {exc}") from exc
    raise SystemExit(f"{name} 必须是 JSON 数组")


def parse_csv(name: str) -> list[str]:
    raw = env(name)
    if not raw:
        return []
    return [item.strip() for item in raw.split(",") if item.strip()]


def toml_string(value: Any) -> str:
    return json.dumps(str(value), ensure_ascii=False)


def toml_bool(value: str | bool) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return "true" if value.strip().lower() in {"1", "true", "yes", "y", "on"} else "false"


def toml_array(values: list[Any]) -> str:
    return "[" + ", ".join(toml_value(item) for item in values) + "]"


def toml_inline_table(value: dict[str, Any]) -> str:
    pairs = []
    for key, item in value.items():
        pairs.append(f"{key} = {toml_value(item)}")
    return "{ " + ", ".join(pairs) + " }"


def toml_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int) or isinstance(value, float):
        return str(value)
    if isinstance(value, list):
        return toml_array(value)
    if isinstance(value, dict):
        return toml_inline_table(value)
    return toml_string(value)


def add_var(lines: list[str], key: str, value: Any, *, include_empty: bool = False) -> None:
    if value is None:
        return
    if isinstance(value, str) and not value and not include_empty:
        return
    if isinstance(value, list) and not value and not include_empty:
        return
    lines.append(f"{key} = {toml_value(value)}")


def main() -> int:
    worker_name = env("TEMP_MAIL_WORKER_NAME", "cloudflare_temp_email")
    worker_route = env("TEMP_MAIL_WORKER_ROUTE")
    d1_name = env("D1_DATABASE_NAME", env("TEMP_MAIL_D1_NAME", "cloudflare_temp_email"))
    d1_id = env("D1_DATABASE_ID")
    if not d1_id:
        print("D1_DATABASE_ID 为空，无法生成 Worker D1 绑定", file=sys.stderr)
        return 2

    domains = parse_json_array("TEMP_MAIL_DOMAINS_JSON") or parse_csv("TEMP_MAIL_DOMAINS")
    default_domains = parse_json_array("TEMP_MAIL_DEFAULT_DOMAINS_JSON") or parse_csv("TEMP_MAIL_DEFAULT_DOMAINS") or domains
    random_subdomain_domains = parse_json_array("TEMP_MAIL_RANDOM_SUBDOMAIN_DOMAINS_JSON") or parse_csv("TEMP_MAIL_RANDOM_SUBDOMAIN_DOMAINS")
    domain_labels = parse_json_array("TEMP_MAIL_DOMAIN_LABELS_JSON")
    user_roles = parse_json_array("TEMP_MAIL_USER_ROLES_JSON")

    if not domains:
        print("TEMP_MAIL_DOMAINS_JSON/TEMP_MAIL_DOMAINS 为空，至少需要配置一个邮箱域名", file=sys.stderr)
        return 2

    lines: list[str] = []
    lines.append(f"name = {toml_string(worker_name)}")
    lines.append('main = "src/worker.ts"')
    lines.append('compatibility_date = "2025-04-01"')
    lines.append('compatibility_flags = ["nodejs_compat"]')
    lines.append("keep_vars = true")

    if worker_route:
        lines.append("routes = [")
        lines.append(f"  {{ pattern = {toml_string(worker_route)}, custom_domain = true }},")
        lines.append("]")

    if toml_bool(env("USE_WORKER_ASSETS", "false")) == "true":
        lines.append("")
        lines.append("[assets]")
        lines.append('directory = "../frontend/dist/"')
        lines.append('binding = "ASSETS"')
        lines.append("run_worker_first = true")

    cron = env("TEMP_MAIL_CRON")
    if cron:
        lines.append("")
        lines.append("[triggers]")
        lines.append(f"crons = [{toml_string(cron)}]")

    lines.append("")
    lines.append("[vars]")
    add_var(lines, "PREFIX", env("TEMP_MAIL_PREFIX"), include_empty=True)
    add_var(lines, "DEFAULT_DOMAINS", default_domains)
    add_var(lines, "DOMAINS", domains)
    add_var(lines, "RANDOM_SUBDOMAIN_DOMAINS", random_subdomain_domains)
    add_var(lines, "RANDOM_SUBDOMAIN_LENGTH", int(env("TEMP_MAIL_RANDOM_SUBDOMAIN_LENGTH", "8")))
    add_var(lines, "DOMAIN_LABELS", domain_labels)
    add_var(lines, "ENABLE_CREATE_ADDRESS_SUBDOMAIN_MATCH", toml_bool(env("TEMP_MAIL_ENABLE_CREATE_ADDRESS_SUBDOMAIN_MATCH", "true")) == "true")
    add_var(lines, "ENABLE_USER_CREATE_EMAIL", toml_bool(env("TEMP_MAIL_ENABLE_USER_CREATE_EMAIL", "true")) == "true")
    add_var(lines, "ENABLE_USER_DELETE_EMAIL", toml_bool(env("TEMP_MAIL_ENABLE_USER_DELETE_EMAIL", "true")) == "true")
    add_var(lines, "ENABLE_ADDRESS_PASSWORD", toml_bool(env("TEMP_MAIL_ENABLE_ADDRESS_PASSWORD", "true")) == "true")
    add_var(lines, "DISABLE_SHOW_GITHUB", toml_bool(env("TEMP_MAIL_DISABLE_SHOW_GITHUB", "true")) == "true")
    add_var(lines, "USER_DEFAULT_ROLE", env("TEMP_MAIL_USER_DEFAULT_ROLE", "member"))
    add_var(lines, "USER_ROLES", user_roles)
    add_var(lines, "NO_LIMIT_SEND_ROLE", env("TEMP_MAIL_NO_LIMIT_SEND_ROLE", "admin"))
    add_var(lines, "FRONTEND_URL", env("TEMP_MAIL_FRONTEND_URL"))

    # Optional explicit sensitive overrides. Leave empty to preserve existing
    # Worker vars through keep_vars=true.
    add_var(lines, "JWT_SECRET", env("TEMP_MAIL_JWT_SECRET"))
    add_var(lines, "ADMIN_PASSWORDS", parse_json_array("TEMP_MAIL_ADMIN_PASSWORDS_JSON"))
    add_var(lines, "PASSWORDS", parse_json_array("TEMP_MAIL_PASSWORDS_JSON"))

    lines.append("")
    lines.append("[[d1_databases]]")
    lines.append('binding = "DB"')
    lines.append(f"database_name = {toml_string(d1_name)}")
    lines.append(f"database_id = {toml_string(d1_id)}")

    kv_id = env("TEMP_MAIL_KV_ID")
    if kv_id:
        lines.append("")
        lines.append("[[kv_namespaces]]")
        lines.append('binding = "KV"')
        lines.append(f"id = {toml_string(kv_id)}")

    print("\n".join(lines) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
