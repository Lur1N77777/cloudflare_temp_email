#!/usr/bin/env python3
"""Render worker/wrangler.toml for GitHub Actions deployment.

The generated config owns the Worker `[vars]` section, so sensitive runtime
values that must survive deployment are required as GitHub Secrets. Do not rely
on `keep_vars = true` alone for JWT/admin password preservation.
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


def require_secret(name: str, description: str) -> str:
    value = env(name)
    if not value:
        raise SystemExit(
            f"{name} 为空，自动生成 wrangler.toml 时必须配置 {description}。"
            "请在 GitHub Repository secrets 中设置该值，或改用 BACKEND_TOML 完整接管 worker/wrangler.toml。"
        )
    return value


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
    send_mail_domains = parse_json_array("TEMP_MAIL_SEND_MAIL_DOMAINS_JSON") or parse_csv("TEMP_MAIL_SEND_MAIL_DOMAINS")
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

    if toml_bool(env("TEMP_MAIL_ENABLE_SEND_MAIL_BINDING", "false")) == "true":
        lines.append("")
        lines.append("send_email = [")
        if toml_bool(env("TEMP_MAIL_SEND_MAIL_REMOTE", "false")) == "true":
            lines.append('   { name = "SEND_MAIL", remote = true },')
        else:
            lines.append('   { name = "SEND_MAIL" },')
        lines.append("]")

    cron = env("TEMP_MAIL_CRON")
    if cron:
        lines.append("")
        lines.append("[triggers]")
        lines.append(f"crons = [{toml_string(cron)}]")

    jwt_secret = require_secret("TEMP_MAIL_JWT_SECRET", "JWT_SECRET")
    admin_passwords = parse_json_array("TEMP_MAIL_ADMIN_PASSWORDS_JSON")
    if not admin_passwords:
        raise SystemExit(
            "TEMP_MAIL_ADMIN_PASSWORDS_JSON 为空，自动生成 wrangler.toml 时必须配置至少一个管理员密码。"
            "例如：[\"your-admin-password\"]。"
        )
    site_passwords = parse_json_array("TEMP_MAIL_PASSWORDS_JSON")

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
    add_var(lines, "SEND_MAIL_DOMAINS", send_mail_domains)
    add_var(lines, "FRONTEND_URL", env("TEMP_MAIL_FRONTEND_URL"))

    # Required sensitive vars for generated config. Do not rely on keep_vars here:
    # Wrangler-managed [vars] can replace existing dashboard variables during deploy.
    add_var(lines, "JWT_SECRET", jwt_secret)
    add_var(lines, "ADMIN_PASSWORDS", admin_passwords)
    add_var(lines, "PASSWORDS", site_passwords)

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
