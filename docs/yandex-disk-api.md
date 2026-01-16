# Yandex Disk API Documentation

This document provides a structured overview of the Yandex Disk API endpoints used by the Obsidian Yandex Disk Sync plugin.

## Table of Contents

-   [Resources API](#resources-api)
-   [Files API](#files-api)
-   [Upload/Download API](#uploaddownload-api)
-   [Public Resources API](#public-resources-api)
-   [Error Handling](#error-handling)

## Resources API

### GET /v1/disk/resources

**Get metadata about a file or directory**

If the path points to a directory, the response also describes the resources in that directory.

#### Parameters

| Parameter      | Required | Type    | Description                                            |
| -------------- | -------- | ------- | ------------------------------------------------------ |
| `path`         | Yes      | string  | Path to the resource                                   |
| `fields`       | No       | string  | List of returned attributes                            |
| `limit`        | No       | long    | Number of nested resources to display                  |
| `offset`       | No       | long    | Offset from the beginning of the nested resources list |
| `preview_crop` | No       | boolean | Allow preview cropping                                 |
| `preview_size` | No       | string  | Preview size                                           |
| `sort`         | No       | string  | Field for sorting nested resources                     |

#### Response Structure (Status 200)

```json
{
	"path": "string",
	"type": "string",
	"name": "string",
	"created": "2026-01-06T22:15:13.197Z",
	"modified": "2026-01-06T22:15:13.197Z",
	"size": 0,
	"mime_type": "string",
	"md5": "string",
	"sha256": "string",
	"preview": "string",
	"public_key": "string",
	"public_url": "string",
	"_embedded": {
		"total": 0,
		"limit": 0,
		"offset": 0,
		"path": "string",
		"sort": "string",
		"items": [
			{
				"path": "string",
				"type": "string",
				"name": "string",
				"created": "2026-01-06T22:15:13.197Z",
				"modified": "2026-01-06T22:15:13.197Z",
				"size": 0,
				"mime_type": "string",
				"md5": "string",
				"sha256": "string",
				"preview": "string",
				"public_key": "string",
				"public_url": "string"
			}
		]
	},
	"media_type": "string",
	"file": "string",
	"resource_id": "string",
	"share": {
		"is_owned": true,
		"is_root": true,
		"rights": "string"
	},
	"revision": 0,
	"comment_ids": {
		"public_resource": "string",
		"private_resource": "string"
	},
	"custom_properties": {},
	"exif": {
		"date_time": "2026-01-06T22:15:13.197Z",
		"gps_latitude": {},
		"gps_longitude": {}
	},
	"antivirus_status": {},
	"photoslice_time": "2026-01-06T22:15:13.197Z",
	"sizes": [
		{
			"url": "string",
			"name": "string"
		}
	]
}
```

### DELETE /v1/disk/resources

**Delete a file or folder**

By default, moves the resource to the Trash. To delete without moving to trash, use `permanently=true`.

#### Parameters

| Parameter     | Required | Type    | Description                             |
| ------------- | -------- | ------- | --------------------------------------- |
| `path`        | Yes      | string  | Path to the file or folder              |
| `fields`      | No       | string  | List of returned attributes             |
| `force_async` | No       | boolean | Execute asynchronously                  |
| `md5`         | No       | string  | MD5 of the file being deleted           |
| `permanently` | No       | boolean | Delete resource without moving to Trash |

### PUT /v1/disk/resources

**Create a folder**

#### Parameters

| Parameter | Required | Type   | Description                  |
| --------- | -------- | ------ | ---------------------------- |
| `path`    | Yes      | string | Path to the folder to create |
| `fields`  | No       | string | List of returned attributes  |

### PATCH /v1/disk/resources

**Update resource custom properties**

#### Parameters

| Parameter | Required | Type   | Description                    |
| --------- | -------- | ------ | ------------------------------ |
| `path`    | Yes      | string | Path to the resource to update |
| `fields`  | No       | string | List of returned attributes    |
| `body`    | Yes      | object | Custom properties to update    |

#### Request Body

```json
{
	"custom_properties": {}
}
```

## Files API

### GET /v1/disk/resources/files

**Get list of files sorted by name**

#### Parameters

| Parameter      | Required | Type    | Description                                            |
| -------------- | -------- | ------- | ------------------------------------------------------ |
| `fields`       | No       | string  | List of returned attributes                            |
| `limit`        | No       | long    | Number of nested resources to display                  |
| `media_type`   | No       | string  | Filter by media type                                   |
| `offset`       | No       | long    | Offset from the beginning of the nested resources list |
| `preview_crop` | No       | boolean | Allow preview cropping                                 |
| `preview_size` | No       | string  | Preview size                                           |
| `sort`         | No       | string  | Field for sorting resources                            |

### GET /v1/disk/resources/last-uploaded

**Get list of files sorted by upload date**

#### Parameters

| Parameter      | Required | Type    | Description                           |
| -------------- | -------- | ------- | ------------------------------------- |
| `fields`       | No       | string  | List of returned attributes           |
| `limit`        | No       | long    | Number of nested resources to display |
| `media_type`   | No       | string  | Filter by media type                  |
| `preview_crop` | No       | boolean | Allow preview cropping                |
| `preview_size` | No       | string  | Preview size                          |

## Upload/Download API

### GET /v1/disk/resources/download

**Get download link for a file**

#### Parameters

| Parameter | Required | Type   | Description                 |
| --------- | -------- | ------ | --------------------------- |
| `path`    | Yes      | string | Path to the resource        |
| `fields`  | No       | string | List of returned attributes |

#### Response Structure (Status 200)

```json
{
	"method": "string",
	"href": "string",
	"templated": true
}
```

### GET /v1/disk/resources/upload

**Get upload link for a file**

#### Parameters

| Parameter   | Required | Type    | Description                 |
| ----------- | -------- | ------- | --------------------------- |
| `path`      | Yes      | string  | Path to the file on Disk    |
| `fields`    | No       | string  | List of returned attributes |
| `overwrite` | No       | boolean | Overwrite existing file     |

#### Response Structure (Status 200)

```json
{
	"method": "string",
	"href": "string",
	"templated": true,
	"operation_id": "string"
}
```

### POST /v1/disk/resources/upload

**Upload file to Disk via URL**

Upload happens asynchronously. Returns a link to the asynchronous operation.

#### Parameters

| Parameter           | Required | Type    | Description                            |
| ------------------- | -------- | ------- | -------------------------------------- |
| `path`              | Yes      | string  | Path where the resource will be placed |
| `url`               | Yes      | string  | URL of external resource to upload     |
| `disable_redirects` | No       | boolean | Disable redirects                      |
| `fields`            | No       | string  | List of returned attributes            |

## Public Resources API

### GET /v1/disk/resources/public

**Get list of published resources**

#### Parameters

| Parameter      | Required | Type    | Description                                 |
| -------------- | -------- | ------- | ------------------------------------------- |
| `fields`       | No       | string  | List of returned attributes                 |
| `limit`        | No       | long    | Number of resources to display              |
| `offset`       | No       | long    | Offset from the beginning of resources list |
| `preview_crop` | No       | boolean | Allow preview cropping                      |
| `preview_size` | No       | string  | Preview size                                |
| `type`         | No       | string  | Filter by resource types                    |

### PUT /v1/disk/resources/publish

**Publish a resource**

#### Parameters

| Parameter              | Required | Type    | Description                     |
| ---------------------- | -------- | ------- | ------------------------------- |
| `path`                 | Yes      | string  | Path to the resource to publish |
| `allow_address_access` | No       | boolean | Allow address access            |
| `fields`               | No       | string  | List of returned attributes     |
| `body`                 | Yes      | object  | Publication settings            |

#### Request Body

```json
{
	"public_settings": {
		"available_until": 0,
		"read_only": true,
		"available_until_verbose": {
			"enabled": true,
			"value": 0
		},
		"password": "string",
		"password_verbose": {
			"enabled": true,
			"value": "string"
		},
		"external_organization_id": "string",
		"external_organization_id_verbose": {
			"enabled": true,
			"value": "string"
		},
		"accesses": [{}]
	}
}
```

### PUT /v1/disk/resources/unpublish

**Unpublish a resource**

#### Parameters

| Parameter | Required | Type   | Description                 |
| --------- | -------- | ------ | --------------------------- |
| `path`    | Yes      | string | Path to the resource        |
| `fields`  | No       | string | List of returned attributes |

## Error Handling

### Common HTTP Status Codes

| Code | Description                                        | Error Response          |
| ---- | -------------------------------------------------- | ----------------------- |
| 200  | OK                                                 | -                       |
| 201  | Created                                            | -                       |
| 202  | Operation is being performed asynchronously        | Link to operation       |
| 204  | No Content (successful deletion)                   | -                       |
| 400  | Incorrect data                                     | Error object            |
| 401  | Not authorized                                     | Error object            |
| 403  | API unavailable (read-only mode)                   | Error object            |
| 404  | Resource not found                                 | Error object            |
| 406  | Resource cannot be represented in requested format | Error object            |
| 409  | Resource already exists                            | Error object            |
| 413  | File too large                                     | Error object with limit |
| 423  | Resource locked or technical work                  | Error object            |
| 429  | Too many requests                                  | Error object            |
| 503  | Service temporarily unavailable                    | Error object            |
| 507  | Insufficient free space                            | Error object            |

### Error Response Structure

```json
{
	"error": "string",
	"description": "string",
	"message": "string",
	"reason": "string",
	"limit": 0
}
```

## File Operations

### POST /v1/disk/resources/copy

**Copy a file or folder**

#### Parameters

| Parameter     | Required | Type    | Description                  |
| ------------- | -------- | ------- | ---------------------------- |
| `from`        | Yes      | string  | Path to the resource to copy |
| `path`        | Yes      | string  | Path to the created resource |
| `fields`      | No       | string  | List of returned attributes  |
| `force_async` | No       | boolean | Execute asynchronously       |
| `overwrite`   | No       | boolean | Overwrite existing resource  |

### POST /v1/disk/resources/move

**Move a file or folder**

#### Parameters

| Parameter     | Required | Type    | Description                  |
| ------------- | -------- | ------- | ---------------------------- |
| `from`        | Yes      | string  | Path to the resource to move |
| `path`        | Yes      | string  | Path to the created resource |
| `fields`      | No       | string  | List of returned attributes  |
| `force_async` | No       | boolean | Execute asynchronously       |
| `overwrite`   | No       | boolean | Overwrite existing resource  |

## Additional Endpoints

### GET /v1/disk/resources/short-info

**Check user access to resource**

#### Parameters

| Parameter | Required | Type   | Description                 |
| --------- | -------- | ------ | --------------------------- |
| `path`    | Yes      | string | Path to the resource        |
| `fields`  | No       | string | List of returned attributes |

#### Response Structure (Status 200)

```json
{
	"path": "string",
	"type": "string",
	"name": "string",
	"mime_type": "string",
	"size": 0,
	"md5": "string",
	"sha256": "string",
	"hid": "string"
}
```

## Notes

-   All API calls require OAuth authentication with a valid access token
-   Paths should be URL-encoded
-   File operations may be asynchronous and return operation links
-   The `_embedded` field contains nested resources when querying directories
-   Error responses include detailed error information for debugging

---

Как получить токен по пользовательскому флоу:
- Пользователь должен вручную создать клиент на https://oauth.yandex.ru/ и получить clientId
- Потом перейти на https://oauth.yandex.ru/authorize?response_type=token&client_id=<clientId> и скопировать токен


---

Пример ответа на GET https://cloud-api.yandex.net/v1/disk/resources?path=obsidian-yandex-disk-sync%2Fobsidian-work


```
{
  "path": "disk:/obsidian-yandex-disk-sync/obsidian-work",
  "type": "dir",
  "name": "obsidian-work",
  "created": "2026-01-13T14:25:30+00:00",
  "modified": "2026-01-13T14:25:30+00:00",
  "_embedded": {
    "path": "disk:/obsidian-yandex-disk-sync/obsidian-work",
    "limit": 20,
    "offset": 0,
    "sort": "",
    "total": 9,
    "items": [
      {
        "path": "disk:/obsidian-yandex-disk-sync/obsidian-work/Clippings",
        "type": "dir",
        "name": "Clippings",
        "created": "2026-01-13T14:25:45+00:00",
        "modified": "2026-01-13T14:25:45+00:00",
        "resource_id": "141032637:2b275d46b2b90d11efecb17cce3707c403ea7a1ed02bb0f2150a850b05dd2643",
        "revision": 1768314345907007,
        "comment_ids": {
          "public_resource": "141032637:2b275d46b2b90d11efecb17cce3707c403ea7a1ed02bb0f2150a850b05dd2643",
          "private_resource": "141032637:2b275d46b2b90d11efecb17cce3707c403ea7a1ed02bb0f2150a850b05dd2643"
        },
        "exif": {}
      },
      {
        "path": "disk:/obsidian-yandex-disk-sync/obsidian-work/Буффер",
        "type": "dir",
        "name": "Буффер",
        "created": "2026-01-13T14:26:07+00:00",
        "modified": "2026-01-13T14:26:07+00:00",
        "resource_id": "141032637:74169c81701259133bb39f43bca9ebf8ff79785f394a41ade1eb12f7bb34d35d",
        "revision": 1768314367855483,
        "comment_ids": {
          "public_resource": "141032637:74169c81701259133bb39f43bca9ebf8ff79785f394a41ade1eb12f7bb34d35d",
          "private_resource": "141032637:74169c81701259133bb39f43bca9ebf8ff79785f394a41ade1eb12f7bb34d35d"
        },
        "exif": {}
      },
      {
        "path": "disk:/obsidian-yandex-disk-sync/obsidian-work/Промпты",
        "type": "dir",
        "name": "Промпты",
        "created": "2026-01-13T14:25:36+00:00",
        "modified": "2026-01-13T14:25:36+00:00",
        "resource_id": "141032637:1d55f70b72125326cd3542e88a675b0d8e503b234ead260b0a3580760f25f170",
        "revision": 1768314336154990,
        "comment_ids": {
          "public_resource": "141032637:1d55f70b72125326cd3542e88a675b0d8e503b234ead260b0a3580760f25f170",
          "private_resource": "141032637:1d55f70b72125326cd3542e88a675b0d8e503b234ead260b0a3580760f25f170"
        },
        "exif": {}
      },
      {
        "path": "disk:/obsidian-yandex-disk-sync/obsidian-work/Статьи",
        "type": "dir",
        "name": "Статьи",
        "created": "2026-01-13T14:25:30+00:00",
        "modified": "2026-01-13T14:25:30+00:00",
        "resource_id": "141032637:89c84d05cd072974343458380956b423505d7dfb3fbc97c74040d08000c9c73f",
        "revision": 1768314330655495,
        "comment_ids": {
          "public_resource": "141032637:89c84d05cd072974343458380956b423505d7dfb3fbc97c74040d08000c9c73f",
          "private_resource": "141032637:89c84d05cd072974343458380956b423505d7dfb3fbc97c74040d08000c9c73f"
        },
        "exif": {}
      },
      {
        "path": "disk:/obsidian-yandex-disk-sync/obsidian-work/obsidian-yandex-disk-index.json",
        "type": "file",
        "name": "obsidian-yandex-disk-index.json",
        "created": "2026-01-15T10:02:23+00:00",
        "modified": "2026-01-15T10:02:23+00:00",
        "size": 4557,
        "mime_type": "application/json",
        "md5": "9f9643770ce4ac67ad5a9a0eee679225",
        "sha256": "d5ac8768a1daea15bba1d3906b14484f8957358c0e7e7b4af0f027813c50a969",
        "media_type": "unknown",
        "resource_id": "141032637:8ec6fa2f036c500a17d3accacd54ba6b4a287f9db1c261af8d5bc588e3296790",
        "revision": 1768471344040470,
        "comment_ids": {
          "public_resource": "141032637:8ec6fa2f036c500a17d3accacd54ba6b4a287f9db1c261af8d5bc588e3296790",
          "private_resource": "141032637:8ec6fa2f036c500a17d3accacd54ba6b4a287f9db1c261af8d5bc588e3296790"
        },
        "exif": {},
        "antivirus_status": "clean",
        "file": "https://downloader.disk.yandex.ru/disk/998b560a6e0243cb51d61ef2ed671a1a10474b30428ab9bc583b43de9e6c9eba/696ae3b6/aD9pYAvilj-5qtI7VXZygXLNnceUJ6UiBnDaQKh_61y4SX-nqoR_VV54wztL1AkCVj2dNK7OcisaUXmHcLzC_w%3D%3D?uid=141032637&filename=obsidian-yandex-disk-index.json&disposition=attachment&hash=&limit=0&content_type=application%2Fjson&owner_uid=141032637&fsize=4557&hid=9ab3dd41ee612c7fe3b0a4ab2383c1a3&media_type=unknown&tknv=v3&etag=9f9643770ce4ac67ad5a9a0eee679225"
      },
      {
        "path": "disk:/obsidian-yandex-disk-sync/obsidian-work/Без названия.md",
        "type": "file",
        "name": "Без названия.md",
        "created": "2026-01-15T10:02:20+00:00",
        "modified": "2026-01-15T10:02:20+00:00",
        "size": 40,
        "mime_type": "text/plain",
        "md5": "c25aa6c5fc0fec36ba9d66cd981e15da",
        "sha256": "7de9c59c9831487f654453af79d2d2857cb2a17d8a5ec400a292692d48fde778",
        "media_type": "compressed",
        "resource_id": "141032637:140ae9f0d63252b5798c636341eaef6bf14879143cd6b0c7cc8e568033435fc6",
        "revision": 1768471340970867,
        "comment_ids": {
          "public_resource": "141032637:140ae9f0d63252b5798c636341eaef6bf14879143cd6b0c7cc8e568033435fc6",
          "private_resource": "141032637:140ae9f0d63252b5798c636341eaef6bf14879143cd6b0c7cc8e568033435fc6"
        },
        "exif": {},
        "antivirus_status": "clean",
        "file": "https://downloader.disk.yandex.ru/disk/146ac3364425280897c232452ad4b601ab5928fdf1a6219cc2337000160c097c/696ae3b6/aD9pYAvilj-5qtI7VXZygcor8XZ7oMJdikDV3nwee1Pj4UAhS8oSfmyPdMnJgvnvPUDaLNdCHxBnNljoVct03w%3D%3D?uid=141032637&filename=%D0%91%D0%B5%D0%B7%20%D0%BD%D0%B0%D0%B7%D0%B2%D0%B0%D0%BD%D0%B8%D1%8F.md&disposition=attachment&hash=&limit=0&content_type=text%2Fplain&owner_uid=141032637&fsize=40&hid=759db4e664478f23b60770b94720216f&media_type=compressed&tknv=v3&etag=c25aa6c5fc0fec36ba9d66cd981e15da"
      },
      {
        "path": "disk:/obsidian-yandex-disk-sync/obsidian-work/Тестовая заметка да 3234.md",
        "type": "file",
        "name": "Тестовая заметка да 3234.md",
        "created": "2026-01-15T09:56:23+00:00",
        "modified": "2026-01-15T09:56:23+00:00",
        "size": 21,
        "mime_type": "text/plain",
        "md5": "84d188995dbd267bda9443d96eff1f1b",
        "sha256": "c9ef03ed7e8f9bc481576c114da1957bf43c81573567863755db05f5492f2efc",
        "media_type": "compressed",
        "resource_id": "141032637:24fd05730d150c724e203ea0a54d8ab1c28dbde81a99cc54a99cae697479a929",
        "revision": 1768470983996315,
        "comment_ids": {
          "public_resource": "141032637:24fd05730d150c724e203ea0a54d8ab1c28dbde81a99cc54a99cae697479a929",
          "private_resource": "141032637:24fd05730d150c724e203ea0a54d8ab1c28dbde81a99cc54a99cae697479a929"
        },
        "exif": {},
        "antivirus_status": "clean",
        "file": "https://downloader.disk.yandex.ru/disk/aafab28705ed08d0461a9a0ae8259a80103740453221e63d05203459619e9f1d/696ae3b6/aD9pYAvilj-5qtI7VXZygRxvCnceRFxniXHbeIGCvgiwGt10lA1R66IhqdwzItULixiSCkFoRsHBxHEf66OP-Q%3D%3D?uid=141032637&filename=%D0%A2%D0%B5%D1%81%D1%82%D0%BE%D0%B2%D0%B0%D1%8F%20%D0%B7%D0%B0%D0%BC%D0%B5%D1%82%D0%BA%D0%B0%20%D0%B4%D0%B0%203234.md&disposition=attachment&hash=&limit=0&content_type=text%2Fplain&owner_uid=141032637&fsize=21&hid=557d30aade839150819009362d9acc5d&media_type=compressed&tknv=v3&etag=84d188995dbd267bda9443d96eff1f1b"
      },
      {
        "path": "disk:/obsidian-yandex-disk-sync/obsidian-work/Тестовая заметка да.md",
        "type": "file",
        "name": "Тестовая заметка да.md",
        "created": "2026-01-15T09:44:49+00:00",
        "modified": "2026-01-15T09:44:49+00:00",
        "size": 4,
        "mime_type": "text/plain",
        "md5": "e04af96afe53462f72f39331b209a810",
        "sha256": "93e6073f9005224b87428f26194784deb52ed7c12da309105f100db2b2a06299",
        "preview": "https://downloader.disk.yandex.ru/preview/b18c015501e9ff451493dc2222ff1eb1b34f9729b270ee8b9b8751bd570e6a22/inf/boZTRJASuG_SzQN-gaChoVhizFYi5FyFUaer1xpwGxd7XSo_fLMxiS47yWAkgtnfA0G2NEjyNX5XVuCD8ylfGA%3D%3D?uid=141032637&filename=%D0%A2%D0%B5%D1%81%D1%82%D0%BE%D0%B2%D0%B0%D1%8F%20%D0%B7%D0%B0%D0%BC%D0%B5%D1%82%D0%BA%D0%B0%20%D0%B4%D0%B0.md&disposition=inline&hash=&limit=0&content_type=image%2Fjpeg&owner_uid=141032637&tknv=v3&size=S&crop=0",
        "media_type": "compressed",
        "sizes": [
          {
            "url": "https://downloader.disk.yandex.ru/preview/b18c015501e9ff451493dc2222ff1eb1b34f9729b270ee8b9b8751bd570e6a22/inf/boZTRJASuG_SzQN-gaChoVhizFYi5FyFUaer1xpwGxd7XSo_fLMxiS47yWAkgtnfA0G2NEjyNX5XVuCD8ylfGA%3D%3D?uid=141032637&filename=%D0%A2%D0%B5%D1%81%D1%82%D0%BE%D0%B2%D0%B0%D1%8F%20%D0%B7%D0%B0%D0%BC%D0%B5%D1%82%D0%BA%D0%B0%20%D0%B4%D0%B0.md&disposition=inline&hash=&limit=0&content_type=image%2Fjpeg&owner_uid=141032637&tknv=v3",
            "name": "DEFAULT"
          },
          {
            "url": "https://downloader.disk.yandex.ru/preview/b18c015501e9ff451493dc2222ff1eb1b34f9729b270ee8b9b8751bd570e6a22/inf/boZTRJASuG_SzQN-gaChoVhizFYi5FyFUaer1xpwGxd7XSo_fLMxiS47yWAkgtnfA0G2NEjyNX5XVuCD8ylfGA%3D%3D?uid=141032637&filename=%D0%A2%D0%B5%D1%81%D1%82%D0%BE%D0%B2%D0%B0%D1%8F%20%D0%B7%D0%B0%D0%BC%D0%B5%D1%82%D0%BA%D0%B0%20%D0%B4%D0%B0.md&disposition=inline&hash=&limit=0&content_type=image%2Fjpeg&owner_uid=141032637&tknv=v3&size=XXXS&crop=0",
            "name": "XXXS"
          },
          {
            "url": "https://downloader.disk.yandex.ru/preview/b18c015501e9ff451493dc2222ff1eb1b34f9729b270ee8b9b8751bd570e6a22/inf/boZTRJASuG_SzQN-gaChoVhizFYi5FyFUaer1xpwGxd7XSo_fLMxiS47yWAkgtnfA0G2NEjyNX5XVuCD8ylfGA%3D%3D?uid=141032637&filename=%D0%A2%D0%B5%D1%81%D1%82%D0%BE%D0%B2%D0%B0%D1%8F%20%D0%B7%D0%B0%D0%BC%D0%B5%D1%82%D0%BA%D0%B0%20%D0%B4%D0%B0.md&disposition=inline&hash=&limit=0&content_type=image%2Fjpeg&owner_uid=141032637&tknv=v3&size=XXS&crop=0",
            "name": "XXS"
          },
          {
            "url": "https://downloader.disk.yandex.ru/preview/b18c015501e9ff451493dc2222ff1eb1b34f9729b270ee8b9b8751bd570e6a22/inf/boZTRJASuG_SzQN-gaChoVhizFYi5FyFUaer1xpwGxd7XSo_fLMxiS47yWAkgtnfA0G2NEjyNX5XVuCD8ylfGA%3D%3D?uid=141032637&filename=%D0%A2%D0%B5%D1%81%D1%82%D0%BE%D0%B2%D0%B0%D1%8F%20%D0%B7%D0%B0%D0%BC%D0%B5%D1%82%D0%BA%D0%B0%20%D0%B4%D0%B0.md&disposition=inline&hash=&limit=0&content_type=image%2Fjpeg&owner_uid=141032637&tknv=v3&size=XS&crop=0",
            "name": "XS"
          },
          {
            "url": "https://downloader.disk.yandex.ru/preview/b18c015501e9ff451493dc2222ff1eb1b34f9729b270ee8b9b8751bd570e6a22/inf/boZTRJASuG_SzQN-gaChoVhizFYi5FyFUaer1xpwGxd7XSo_fLMxiS47yWAkgtnfA0G2NEjyNX5XVuCD8ylfGA%3D%3D?uid=141032637&filename=%D0%A2%D0%B5%D1%81%D1%82%D0%BE%D0%B2%D0%B0%D1%8F%20%D0%B7%D0%B0%D0%BC%D0%B5%D1%82%D0%BA%D0%B0%20%D0%B4%D0%B0.md&disposition=inline&hash=&limit=0&content_type=image%2Fjpeg&owner_uid=141032637&tknv=v3&size=S&crop=0",
            "name": "S"
          },
          {
            "url": "https://downloader.disk.yandex.ru/preview/b18c015501e9ff451493dc2222ff1eb1b34f9729b270ee8b9b8751bd570e6a22/inf/boZTRJASuG_SzQN-gaChoVhizFYi5FyFUaer1xpwGxd7XSo_fLMxiS47yWAkgtnfA0G2NEjyNX5XVuCD8ylfGA%3D%3D?uid=141032637&filename=%D0%A2%D0%B5%D1%81%D1%82%D0%BE%D0%B2%D0%B0%D1%8F%20%D0%B7%D0%B0%D0%BC%D0%B5%D1%82%D0%BA%D0%B0%20%D0%B4%D0%B0.md&disposition=inline&hash=&limit=0&content_type=image%2Fjpeg&owner_uid=141032637&tknv=v3&size=M&crop=0",
            "name": "M"
          },
          {
            "url": "https://downloader.disk.yandex.ru/preview/b18c015501e9ff451493dc2222ff1eb1b34f9729b270ee8b9b8751bd570e6a22/inf/boZTRJASuG_SzQN-gaChoVhizFYi5FyFUaer1xpwGxd7XSo_fLMxiS47yWAkgtnfA0G2NEjyNX5XVuCD8ylfGA%3D%3D?uid=141032637&filename=%D0%A2%D0%B5%D1%81%D1%82%D0%BE%D0%B2%D0%B0%D1%8F%20%D0%B7%D0%B0%D0%BC%D0%B5%D1%82%D0%BA%D0%B0%20%D0%B4%D0%B0.md&disposition=inline&hash=&limit=0&content_type=image%2Fjpeg&owner_uid=141032637&tknv=v3&size=L&crop=0",
            "name": "L"
          },
          {
            "url": "https://downloader.disk.yandex.ru/preview/b18c015501e9ff451493dc2222ff1eb1b34f9729b270ee8b9b8751bd570e6a22/inf/boZTRJASuG_SzQN-gaChoVhizFYi5FyFUaer1xpwGxd7XSo_fLMxiS47yWAkgtnfA0G2NEjyNX5XVuCD8ylfGA%3D%3D?uid=141032637&filename=%D0%A2%D0%B5%D1%81%D1%82%D0%BE%D0%B2%D0%B0%D1%8F%20%D0%B7%D0%B0%D0%BC%D0%B5%D1%82%D0%BA%D0%B0%20%D0%B4%D0%B0.md&disposition=inline&hash=&limit=0&content_type=image%2Fjpeg&owner_uid=141032637&tknv=v3&size=XL&crop=0",
            "name": "XL"
          },
          {
            "url": "https://downloader.disk.yandex.ru/preview/b18c015501e9ff451493dc2222ff1eb1b34f9729b270ee8b9b8751bd570e6a22/inf/boZTRJASuG_SzQN-gaChoVhizFYi5FyFUaer1xpwGxd7XSo_fLMxiS47yWAkgtnfA0G2NEjyNX5XVuCD8ylfGA%3D%3D?uid=141032637&filename=%D0%A2%D0%B5%D1%81%D1%82%D0%BE%D0%B2%D0%B0%D1%8F%20%D0%B7%D0%B0%D0%BC%D0%B5%D1%82%D0%BA%D0%B0%20%D0%B4%D0%B0.md&disposition=inline&hash=&limit=0&content_type=image%2Fjpeg&owner_uid=141032637&tknv=v3&size=XXL&crop=0",
            "name": "XXL"
          },
          {
            "url": "https://downloader.disk.yandex.ru/preview/b18c015501e9ff451493dc2222ff1eb1b34f9729b270ee8b9b8751bd570e6a22/inf/boZTRJASuG_SzQN-gaChoVhizFYi5FyFUaer1xpwGxd7XSo_fLMxiS47yWAkgtnfA0G2NEjyNX5XVuCD8ylfGA%3D%3D?uid=141032637&filename=%D0%A2%D0%B5%D1%81%D1%82%D0%BE%D0%B2%D0%B0%D1%8F%20%D0%B7%D0%B0%D0%BC%D0%B5%D1%82%D0%BA%D0%B0%20%D0%B4%D0%B0.md&disposition=inline&hash=&limit=0&content_type=image%2Fjpeg&owner_uid=141032637&tknv=v3&size=XXXL&crop=0",
            "name": "XXXL"
          },
          {
            "url": "https://downloader.disk.yandex.ru/preview/b18c015501e9ff451493dc2222ff1eb1b34f9729b270ee8b9b8751bd570e6a22/inf/boZTRJASuG_SzQN-gaChoVhizFYi5FyFUaer1xpwGxd7XSo_fLMxiS47yWAkgtnfA0G2NEjyNX5XVuCD8ylfGA%3D%3D?uid=141032637&filename=%D0%A2%D0%B5%D1%81%D1%82%D0%BE%D0%B2%D0%B0%D1%8F%20%D0%B7%D0%B0%D0%BC%D0%B5%D1%82%D0%BA%D0%B0%20%D0%B4%D0%B0.md&disposition=inline&hash=&limit=0&content_type=image%2Fjpeg&owner_uid=141032637&tknv=v3&size=S&crop=0",
            "name": "C"
          }
        ],
        "resource_id": "141032637:5b9592b9c2e0630ca7c83218d04c9e7f003ea40e03e99c34500d11be13834959",
        "revision": 1768470289761312,
        "comment_ids": {
          "public_resource": "141032637:5b9592b9c2e0630ca7c83218d04c9e7f003ea40e03e99c34500d11be13834959",
          "private_resource": "141032637:5b9592b9c2e0630ca7c83218d04c9e7f003ea40e03e99c34500d11be13834959"
        },
        "exif": {},
        "antivirus_status": "clean",
        "file": "https://downloader.disk.yandex.ru/disk/82a84fb92629b1aa39c23d4658a792f432898ae4135cf9b218c0819b0c09e2ce/696ae3b6/UHnl-P3q9TQb8yDv_03EQR9-qnlo7Q-9ZzHpdiZamqceXRx4wBXWHOnGWF--9G7Mnl-5-290siuomjJZU7-hfg%3D%3D?uid=141032637&filename=%D0%A2%D0%B5%D1%81%D1%82%D0%BE%D0%B2%D0%B0%D1%8F%20%D0%B7%D0%B0%D0%BC%D0%B5%D1%82%D0%BA%D0%B0%20%D0%B4%D0%B0.md&disposition=attachment&hash=&limit=0&content_type=text%2Fplain&owner_uid=141032637&fsize=4&hid=b77df2ec705fe89da631c41e7329930a&media_type=compressed&tknv=v3&etag=e04af96afe53462f72f39331b209a810"
      },
      {
        "path": "disk:/obsidian-yandex-disk-sync/obsidian-work/цууцкц.md",
        "type": "file",
        "name": "цууцкц.md",
        "created": "2026-01-15T09:56:23+00:00",
        "modified": "2026-01-15T09:56:23+00:00",
        "size": 0,
        "mime_type": "text/plain",
        "md5": "d41d8cd98f00b204e9800998ecf8427e",
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "media_type": "compressed",
        "resource_id": "141032637:d8750a1aa9f515eb36be2615fdf1de655ca5e4ae1b8901e14679bb1015fe898c",
        "revision": 1768470983626446,
        "comment_ids": {
          "public_resource": "141032637:d8750a1aa9f515eb36be2615fdf1de655ca5e4ae1b8901e14679bb1015fe898c",
          "private_resource": "141032637:d8750a1aa9f515eb36be2615fdf1de655ca5e4ae1b8901e14679bb1015fe898c"
        },
        "exif": {},
        "antivirus_status": "clean",
        "file": "https://downloader.disk.yandex.ru/disk/b5dd9db0950a58c807c2328d15df3eb1fe16894ff0754ca2e41f6798ea1182b8/696ae3b6/Gc4tJqwF_8gTQTp0ubc_ep9XWkuZmUU6RAYtGaYFlADsV4o_yowDnvDR9nan35DfcVfdPKEY6me_iJVjhqvmbw%3D%3D?uid=141032637&filename=%D1%86%D1%83%D1%83%D1%86%D0%BA%D1%86.md&disposition=attachment&hash=&limit=0&content_type=text%2Fplain&owner_uid=141032637&hid=cbe7b309b4bbe3a94682616cb7e88e01&media_type=compressed&tknv=v3&etag=d41d8cd98f00b204e9800998ecf8427e"
      }
    ]
  },
  "resource_id": "141032637:7d9878417a53922c6236ab8e9114548d51b040c6d49aa0254d73bab828db3947",
  "revision": 1768314330128397,
  "comment_ids": {
    "public_resource": "141032637:7d9878417a53922c6236ab8e9114548d51b040c6d49aa0254d73bab828db3947",
    "private_resource": "141032637:7d9878417a53922c6236ab8e9114548d51b040c6d49aa0254d73bab828db3947"
  },
  "exif": {}
}
```