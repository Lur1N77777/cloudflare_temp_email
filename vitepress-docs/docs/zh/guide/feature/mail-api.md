# 查看邮件 API

## 通过 邮件 API 查看邮件

这是一个 `python` 的例子，使用 `requests` 库查看邮件。

```python
limit = 10
offset = 0
res = requests.get(
    f"https://<你的worker地址>/api/mails?limit={limit}&offset={offset}",
    headers={
        "Authorization": f"Bearer {你的JWT密码}",
        # "x-custom-auth": "<你的网站密码>", # 如果启用了私有站点密码
        "Content-Type": "application/json"
    }
)
```

**注意**：`/api/mails` 按设计返回的是原始 RFC822 数据（如 `source`/`raw`），不保证直接包含 `subject`、`text`、`html` 等已解析字段。若要直接读取正文，请在客户端侧解析 `raw`（例如 `mail-parser-wasm`、`postal-mime`）。

## 游标、批量详情与邮件标记 API

以下三个接口都属于 `/api/*` 地址接口，必须使用当前邮箱的 **Address JWT**，不能使用用户 JWT：

```http
Authorization: Bearer <address-jwt>
```

如果站点启用了私有站点密码，还需要同时提供 `x-custom-auth`。三个接口的 `mailbox` 均可省略（默认 `INBOX`），且只接受 `INBOX` 或 `SENT`，值不区分大小写。

### `GET /api/mail_ids`

按 ID 倒序返回轻量邮件索引，使用稳定的 keyset cursor，适合增量同步和 IMAP：

```http
GET /api/mail_ids?mailbox=INBOX&limit=100&before_id=12345
```

| 参数 | 规则 |
| --- | --- |
| `mailbox` | 可选，`INBOX` 或 `SENT`，默认 `INBOX` |
| `limit` | 可选，默认 `100`；必须是 `1` 到 `200` 的整数 |
| `before_id` | 可选；必须是正的安全整数，只返回 `id < before_id` 的记录 |

响应包含 `results`、`count`、`next_cursor` 和 `has_more`。有下一页时，将 `next_cursor` 原样作为下一次请求的 `before_id`；不要自行用 offset 推算。只有不传 `before_id` 的第一页会计算邮箱总数，后续页的 `count` 为 `0`。`SENT` 的轻量索引来自发件箱，因此 `message_id`、`source` 和 `metadata` 为 `null`。

### `GET /api/mail_details`

按 ID 批量读取当前地址拥有的邮件详情：

```http
GET /api/mail_details?mailbox=SENT&mail_ids=321,320
```

`mail_ids` 是必填的逗号分隔列表，每次最少 1 个、最多 10 个 ID；每个 ID 都必须是互不重复的正安全整数。`INBOX` 返回已解压的 `raw_mails` 记录，`SENT` 返回 `sendbox` 记录；不属于 Address JWT 对应地址的 ID 不会返回。

### `GET /api/mail_flags`

查询当前地址的持久化系统标记：

```http
GET /api/mail_flags?mailbox=INBOX&mail_ids=321,320
```

`mail_ids` 每次最少 1 个、最多 90 个，必须是互不重复的正安全整数。响应为 `{ "results": [{ "mail_id": 321, "flags": ["\\Seen"] }] }`；没有返回的 ID 表示尚未存储任何标记。

### `PATCH /api/mail_flags`

一次最多更新 40 封邮件，`mail_id` 必须互不重复且全部属于当前 Address JWT 的地址：

```json
{
  "mailbox": "SENT",
  "updates": [
    {
      "mail_id": 321,
      "operation": "add",
      "flags": ["\\Seen", "\\Flagged"]
    }
  ]
}
```

`operation` 可省略（默认 `replace`），或设为 `replace`、`add`、`remove`。`flags` 只允许 `\Seen`、`\Answered`、`\Flagged`、`\Deleted`、`\Draft`；任一 ID 不属于当前地址时，整批请求返回 `404`，不会更新其他邮件。

## admin 邮件 API

支持 `address` 过滤

```python
import requests

url = "https://<你的worker地址>/admin/mails"

querystring = {
    "limit":"20",
    "offset":"0",
    # address 为可选参数
    "address":"xxxx@awsl.uk"
}

headers = {
        "x-admin-auth": "<你的Admin密码>",
        # "x-custom-auth": "<你的网站密码>", # 如果启用了私有站点密码
    }

response = requests.get(url, headers=headers, params=querystring)

print(response.json())
```

**注意**：`/admin/mails` 与 `/api/mails` 一致，返回的是邮件数据库中的 raw MIME 内容；如需正文/主题等可读字段，请在客户端自行解析 `raw`。

**注意**：后端 API 已移除关键词过滤功能。如需按内容过滤邮件，请使用前端界面的过滤输入框，该功能可过滤当前显示的页面。

## admin 删除邮件 API

通过邮件 ID 删除单封邮件。

```python
import requests

mail_id = 1
url = f"https://<你的worker地址>/admin/mails/{mail_id}"

headers = {
        "x-admin-auth": "<你的Admin密码>",
        # "x-custom-auth": "<你的网站密码>", # 如果启用了私有站点密码
    }

response = requests.delete(url, headers=headers)

print(response.json())
```

## admin 删除邮箱地址 API

通过邮箱地址 ID 删除邮箱地址（同时删除该地址关联的邮件、发件权限和用户绑定）。

```python
import requests

address_id = 1
url = f"https://<你的worker地址>/admin/delete_address/{address_id}"

headers = {
        "x-admin-auth": "<你的Admin密码>",
        # "x-custom-auth": "<你的网站密码>", # 如果启用了私有站点密码
    }

response = requests.delete(url, headers=headers)

print(response.json())
```

## admin 清空收件箱 API

通过邮箱地址 ID 清空该地址的所有收件。

```python
import requests

address_id = 1
url = f"https://<你的worker地址>/admin/clear_inbox/{address_id}"

headers = {
        "x-admin-auth": "<你的Admin密码>",
        # "x-custom-auth": "<你的网站密码>", # 如果启用了私有站点密码
    }

response = requests.delete(url, headers=headers)

print(response.json())
```

## admin 清空发件箱 API

通过邮箱地址 ID 清空该地址的所有发件。

```python
import requests

address_id = 1
url = f"https://<你的worker地址>/admin/clear_sent_items/{address_id}"

headers = {
        "x-admin-auth": "<你的Admin密码>",
        # "x-custom-auth": "<你的网站密码>", # 如果启用了私有站点密码
    }

response = requests.delete(url, headers=headers)

print(response.json())
```

## user 邮件 API

::: warning 注意：用户 JWT vs 地址 JWT
此接口使用**用户 JWT**（通过 `/user_api/login` 或 `/user_api/register` 获得），使用 `x-user-token` header。

**请勿与地址 JWT 混淆**：
- 地址 JWT 使用 `Authorization: Bearer <jwt>` 访问 `/api/*` 接口
- 用户 JWT 使用 `x-user-token: <jwt>` 访问 `/user_api/*` 接口
:::

支持 `address` 过滤

```python
import requests

url = "https://<你的worker地址>/user_api/mails"

querystring = {
    "limit":"20",
    "offset":"0",
    # address 为可选参数
    "address":"xxxx@awsl.uk"
}

headers = {
        "x-user-token": "<你的用户JWT Token>",
        # "x-custom-auth": "<你的网站密码>", # 如果启用了私有站点密码
    }

response = requests.get(url, headers=headers, params=querystring)

print(response.json())
```

**注意**：`/user_api/mails` 同样返回原始 RFC822 内容；请在客户端解析后提取 `subject`、`text`、`html`。

**注意**：后端 API 已移除关键词过滤功能。如需按内容过滤邮件，请使用前端界面的过滤输入框，该功能可过滤当前显示的页面。
