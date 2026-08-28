# Резервное копирование

## Инварианты

- Backup хранится raw в `{remotePath}/.backup/` и не зависит от active vault
  codec.
- `.backup` не входит в canonical, remote tree sync, Force cleanup или
  пользовательские конфликты.
- Upload всегда использует `overwrite=false`.
- Успех подтверждается raw download и совпадением SHA-256 и точных bytes.
  Server fingerprint сам по себе недостаточен.
- Старые backup не удаляются и не перешифровываются.

## Имена

Новый формат:

```text
backup_YYYY-MM-DD_HH-MM-SS-SSS_<96-bit-random>.zip
backup_YYYY-MM-DD_HH-MM-SS-SSS_<96-bit-random>.enc.zip
```

Исторические имена с точностью до секунды продолжают распознаваться. Новый
`.enc.zip` обязан начинаться с magic envelope `OYDSBKP!`; любой другой
`.enc.zip` является неподдерживаемым историческим форматом.

## Plaintext backup

При выключенном шифровании backup — обычный ZIP exact logical vault snapshot.
Force local создаёт отдельный ZIP `remote-raw`, содержащий raw remote objects;
Force remote создаёт logical local backup.

## Self-contained encrypted envelope

```text
[8 bytes "OYDSBKP!"]
[4 bytes big-endian header length]
[UTF-8 JSON header]
[AES-256-GCM encrypted ZIP + tag]
```

Header содержит только:

- `kind: "logical-vault" | "remote-raw"`;
- `createdAt`, plugin version, file count;
- PBKDF2-HMAC-SHA256, 600 000 iterations, random salt 16 bytes;
- AES-256-GCM, random IV 12 bytes.

Exact UTF-8 header bytes являются AES-GCM AAD. Header ограничен 16 KiB и строго
проверяется до запуска PBKDF2, поэтому remote input не может навязать другую
стоимость KDF. Header не содержит paths, content, secrets или canonical index.

Password policy:

- enable — target password;
- rotate — new password;
- disable — current source password;
- обычный encrypted backup — current password;
- plaintext backup — без password/envelope.

## Upload verification

После success, timeout или 409 клиент выполняет stable raw download. Возможны
только два результата:

- SHA-256 и bytes совпали — операция подтверждена, включая lost response;
- объект отсутствует или bytes отличаются — имя считается collision, создаётся
  новое random имя; существующий объект не перезаписывается.

Force и encryption transition не переходят к destructive phase без успешно
подтверждённого backup. Encryption transition proof привязан к canonical
epoch/revision и digest точных logical bytes, попавших в backup; concurrent
commit или local change инвалидирует proof.

Force сначала выполняет read-only canonical preflight, затем создаёт backup и
передаёт proof внутрь сериализованной Force-сессии. Proof содержит SHA-256
точных remote backup bytes, raw identity canonical и digest защищаемого
snapshot: `remote-raw` для Force local, `logical-vault` для Force remote. До
первого `mkdir`, upload/delete либо local overwrite/delete `SyncEngine` заново
скачивает backup и переснимает canonical/snapshot. Любое отличие блокирует
Force как stale и требует новый backup.

## Download

Download всегда начинается raw:

1. `OYDSBKP!` открывается по bounded параметрам собственного header.
2. Сначала пробуется явно переданный или текущий пароль.
3. При authentication failure UI запрашивает backup password.
4. Пользователю сохраняется обычный `.zip`.

Non-envelope `.enc.zip` отклоняется без вызова compatibility decrypt.
Исторический `.zip` принимается только при наличии plaintext ZIP magic.
Неизвестные bytes и encrypted legacy names не декодируются, download
блокируется, повреждённый `.zip` не сохраняется. Старые архивы не удаляются и
не мигрируются автоматически.

## Memory

Encryption transition создаёт один logical backup после source preflight, а не
объединяет полные local и remote snapshots. Force создаёт только один snapshot
защищаемой стороны. Это сохраняет прежний memory peak. Mobile PERF-006 остаётся
обязательным release gate.

## Проверки

Автоматические проверки покрывают envelope auth/header bounds, wrong password,
corrupted tag/header, lost response, 409/collision, exact read-back, unique
names, plaintext historical ZIP и fail-closed для non-envelope `.enc.zip`,
unknown bytes и encrypted legacy names. Реальное создание, download и restore
до/после rotate/disable входят в `SMOKE_TESTS.md` TC-08. Freshness proof Force
проверяется в TC-07.
