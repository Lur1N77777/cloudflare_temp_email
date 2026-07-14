# Mail API

## Viewing Emails via Mail API

This is a `python` example using the `requests` library to view emails.

```python
limit = 10
offset = 0
res = requests.get(
    f"https://<your-worker-address>/api/mails?limit={limit}&offset={offset}",
    headers={
        "Authorization": f"Bearer {your-JWT-password}",
        # "x-custom-auth": "<your-website-password>", # If private site password is enabled
        "Content-Type": "application/json"
    }
)
```

**Note**: `/api/mails` returns raw RFC822 data by design (for example `source`/`raw`), and it does not guarantee parsed fields such as `subject`, `text`, or `html`. Parse the raw source on the client side (for example with `mail-parser-wasm` or `postal-mime`) if you need readable message content.

## Cursor, Batch Detail, and Mail Flag APIs

All three endpoints below are address-scoped `/api/*` endpoints. They require the current mailbox's **Address JWT**, not a User JWT:

```http
Authorization: Bearer <address-jwt>
```

Also send `x-custom-auth` when the private-site password is enabled. The `mailbox` value is optional on all three endpoints (default `INBOX`) and accepts only `INBOX` or `SENT`, case-insensitively.

### `GET /api/mail_ids`

Returns a lightweight index in descending ID order with a stable keyset cursor, suitable for incremental sync and IMAP:

```http
GET /api/mail_ids?mailbox=INBOX&limit=100&before_id=12345
```

| Parameter | Rules |
| --- | --- |
| `mailbox` | Optional; `INBOX` or `SENT`, default `INBOX` |
| `limit` | Optional, default `100`; must be an integer from `1` through `200` |
| `before_id` | Optional; must be a positive safe integer and returns only rows with `id < before_id` |

The response contains `results`, `count`, `next_cursor`, and `has_more`. When another page exists, pass `next_cursor` unchanged as the next request's `before_id`; do not derive an offset. Only the first request without `before_id` calculates the mailbox total, while later pages return `count: 0`. Lightweight `SENT` rows come from the sendbox, so their `message_id`, `source`, and `metadata` fields are `null`.

### `GET /api/mail_details`

Fetches details for IDs owned by the authenticated address:

```http
GET /api/mail_details?mailbox=SENT&mail_ids=321,320
```

`mail_ids` is a required comma-separated list of 1 to 10 IDs. Every ID must be a unique positive safe integer. `INBOX` returns decompressed `raw_mails` rows and `SENT` returns `sendbox` rows; IDs not owned by the Address JWT's mailbox are not returned.

### `GET /api/mail_flags`

Reads persistent system flags for the authenticated address:

```http
GET /api/mail_flags?mailbox=INBOX&mail_ids=321,320
```

`mail_ids` must contain 1 to 90 unique positive safe integers. A response looks like `{ "results": [{ "mail_id": 321, "flags": ["\\Seen"] }] }`; an omitted ID has no stored flags yet.

### `PATCH /api/mail_flags`

Updates at most 40 mails per request. Every `mail_id` must be unique and owned by the Address JWT's address:

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

`operation` may be omitted (default `replace`) or set to `replace`, `add`, or `remove`. `flags` only accepts `\Seen`, `\Answered`, `\Flagged`, `\Deleted`, and `\Draft`. If any ID is not owned by the authenticated address, the whole request returns `404` without updating the other mails.

## Admin Mail API

Supports `address` filter

```python
import requests

url = "https://<your-worker-address>/admin/mails"

querystring = {
    "limit":"20",
    "offset":"0",
    # address is optional parameter
    "address":"xxxx@awsl.uk"
}

headers = {
        "x-admin-auth": "<your-Admin-password>",
        # "x-custom-auth": "<your-website-password>", # If private site password is enabled
    }

response = requests.get(url, headers=headers, params=querystring)

print(response.json())
```

**Note**: `/admin/mails` follows the same design as `/api/mails`: it returns stored raw MIME data. If you need readable subject/body, parse the raw content on the client side.

**Note**: Keyword filtering has been removed from the backend API. If you need to filter emails by content, please use the frontend filter input in the UI, which filters the currently displayed page.

## Admin Delete Mail API

Delete a single mail by mail ID.

```python
import requests

mail_id = 1
url = f"https://<your-worker-address>/admin/mails/{mail_id}"

headers = {
        "x-admin-auth": "<your-Admin-password>",
        # "x-custom-auth": "<your-website-password>", # If private site password is enabled
    }

response = requests.delete(url, headers=headers)

print(response.json())
```

## Admin Delete Address API

Delete an email address by address ID (also deletes associated mails, sender permissions, and user bindings).

```python
import requests

address_id = 1
url = f"https://<your-worker-address>/admin/delete_address/{address_id}"

headers = {
        "x-admin-auth": "<your-Admin-password>",
        # "x-custom-auth": "<your-website-password>", # If private site password is enabled
    }

response = requests.delete(url, headers=headers)

print(response.json())
```

## Admin Clear Inbox API

Clear all received mails for an address by address ID.

```python
import requests

address_id = 1
url = f"https://<your-worker-address>/admin/clear_inbox/{address_id}"

headers = {
        "x-admin-auth": "<your-Admin-password>",
        # "x-custom-auth": "<your-website-password>", # If private site password is enabled
    }

response = requests.delete(url, headers=headers)

print(response.json())
```

## Admin Clear Sent Items API

Clear all sent mails for an address by address ID.

```python
import requests

address_id = 1
url = f"https://<your-worker-address>/admin/clear_sent_items/{address_id}"

headers = {
        "x-admin-auth": "<your-Admin-password>",
        # "x-custom-auth": "<your-website-password>", # If private site password is enabled
    }

response = requests.delete(url, headers=headers)

print(response.json())
```

## User Mail API

::: warning Note: User JWT vs Address JWT
This endpoint uses **User JWT** (obtained via `/user_api/login` or `/user_api/register`), with `x-user-token` header.

**Do not confuse with Address JWT**:
- Address JWT uses `Authorization: Bearer <jwt>` to access `/api/*` endpoints
- User JWT uses `x-user-token: <jwt>` to access `/user_api/*` endpoints
:::

Supports `address` filter

```python
import requests

url = "https://<your-worker-address>/user_api/mails"

querystring = {
    "limit":"20",
    "offset":"0",
    # address is optional parameter
    "address":"xxxx@awsl.uk"
}

headers = {
        "x-user-token": "<your-user-JWT-token>",
        # "x-custom-auth": "<your-website-password>", # If private site password is enabled
    }

response = requests.get(url, headers=headers, params=querystring)

print(response.json())
```

**Note**: `/user_api/mails` also returns raw RFC822 content from storage; parse it in your client to extract `subject`, `text`, and `html`.

**Note**: Keyword filtering has been removed from the backend API. If you need to filter emails by content, please use the frontend filter input in the UI, which filters the currently displayed page.
