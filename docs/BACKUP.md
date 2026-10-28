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

## Контекст операции

Перед ручным созданием UI показывает подтверждение: локальные syncable файлы,
remote `.backup` и plaintext/encrypted режим без credentials. Отмена не создаёт
архив. После подтверждения заново проверяются lifecycle, контекст и занятость.
Кнопка показывает реальную foreground activity до завершения, без таймера.

Ручное создание архива резервирует foreground operation до первого await и выполняется
через maintenance существующего coordinator. Папка, режим и пароль фиксируются до
чтения файлов и создания ZIP; изменение settings не перенаправляет архив. Force и
transition используют собственное владение, без вложенной очереди.

Connection/scope и конкурирующие foreground операции заблокированы до completion.
Список и download привязаны к поколению конфигурации. Оно меняется только при
смене token/path, encryption-параметров или файлового scope; независимый snapshot
обнаруживает также in-place изменения. Logging/runtime patches не прерывают
скачивание и выбранный transition archive. После смены этого контекста или закрытия
окна старые результаты не применяются; перед повторным download после password prompt
проверяется контекст. Это не мешает открыть старый архив его собственным паролем.

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

Оба способа создания backup предоставляют необязательный callback этапов:
`creating-backup`, `uploading-backup`, `verifying-backup`. Это только UI-события:
этап проверки ещё не означает успеха. Результат `success` возвращается после
проверки exact bytes; потеря ответа и collision могут повторить upload/read-back.
При выборе архива Force показывает этапы в общей плашке с момента подтверждения
и удерживает блокировку кнопок до окончания всего сценария.

После success, timeout или 409 клиент выполняет stable raw download. Возможны
только два результата:

- SHA-256 и bytes совпали — операция подтверждена, включая lost response;
- объект отсутствует или bytes отличаются — имя считается collision, создаётся
  новое random имя; существующий объект не перезаписывается.

Force открывает один диалог до read-only проверки источника и ввода пароля.
После проверки он показывает подтверждение с выключенным по умолчанию выбором
архива и конкретной remote `.backup` папкой. Для Диск → локальное это полный
локальный vault перед заменой; для локальное → Диск — прежнее содержимое Диска.
При ошибке выбранного архива пользователь остаётся в том же диалоге: retry,
отключить архив или cancel. Очистка до создания выбранного архива не начинается.
Явно выбранный архив Force по-прежнему покрывает полное дерево vault без обычных фильтров, кроме корневой
.backup и собственных credentials/state/logs плагина. Старые удалённые копии plugin
data пропускаются без чтения, а не блокируют Force archive.
Local → Disk сохраняет raw remote archive; Disk → local — logical local archive.
Обычные backup/sync и encryption transitions сохраняют прежние scope/защиту.

Без архива Force не скачивает старое пользовательское содержимое destination ради snapshot/validation,
не создаёт ZIP, staging, per-file protective/conflict copies или trash.
До удаления читаются выбранный источник и manifest назначения, а raw metadata
назначения классифицируются через frozen filters. Исключённые ciphertext требуют
сохранения проверенного codec; данные архива не становятся payload Force. Direct-v1 checkpoint и новый canonical принадлежат
существующим persistence/IndexManager; stale destination fingerprints не блокируют
Force. Ordinary full продолжает только оставшиеся действия без нового архива.
Старый scoped checkpoint требует нового подтверждения полного Force.

`crypto/workflow.ts` запрашивает выбранный transition archive через прежний
`BackupManager` после source preflight; claim проверяется в `crypto/maintenance.ts`.
`crypto/recovery.ts` возобновляет только сохранённый transition и не вызывает
создание архива. UI выбора остаётся у plugin root; его persistence port
делегирует coherent snapshot единственному `PluginPersistence`.

Encryption snapshot содержит обязательное `backupProof: EncryptionBackupProof | null`.
Отсутствующее поле недопустимо. Claim проверяет исходную revision и fingerprints
при любом выборе; заполненный proof дополнительно связывает архив с epoch/revision
и logical snapshot. Изменившийся source требует нового запуска. Recovery использует
сохранённый выбор и не создаёт новый архив; подключение к существующему шифрованию
также не архивирует vault.

Metadata scan и remote-raw snapshot блокируют старую remote plugin directory до
скачивания её содержимого. Non-secret remediation marker сохраняет требование
удалить directory и заменить OAuth token.

Stable local data необратимо преобразуется в current snapshot при загрузке, после
installation identity и до автоматизации. Ни эта запись, ни foreign epoch adoption
не создают архив. После подтверждённого Force intent авторитетен новый epoch;
незавершённый direct replacement продолжает обычный full с теми же
ID/epoch, а обычная автоматизация ждёт его завершения. Этот recovery не создаёт
новый архив. Normal full принимает завершённое поколение по правилам epoch choice.

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

`captureLogicalVaultDigest` и `captureRemoteRawDigest` читают и хешируют по
одному файлу, освобождая ссылку на content до следующего чтения. Они сохраняют
только identities `{path,size,sha256}` и тот же SHA-256 от JSON `{kind,files}`.
Для каждого source kind enumeration, localeCompare order и filtering общие с
materialized snapshot: logical scope задаёт VaultAdapter, raw remote исключает
`.backup` и отклоняет plugin data до первого download.

Digest-only используют проверки до/после выбранного архива и encryption source
freshness. Число content reads не сокращается; ошибки read/auth/decrypt и source
drift по-прежнему блокируют proof. Изменён retained content volume, ускорение
сети не заявляется. Canonical, local/physical bytes и durable queues не меняются.

При выборе архива encryption transition создаёт один logical backup после
source preflight; Force архивирует только защищаемую сторону. ZIP-пути сохраняют
полные bytes через `captureLogicalVaultSnapshot`/`captureRemoteRawSnapshot`;
уменьшение peak ZIP/envelope не доказано. Без архива public directed Force
не создаёт destination-content snapshot и не вызывает digest traversal назначения.
Проверка source и новых записанных bytes остаётся обязательной. Воспроизводимая проверка identities находится в `tests/backup-snapshot.test.ts`;
реальный mobile heap — manual `PERF-006`, обязательный release gate.

## Проверки

Автоматические проверки покрывают envelope auth/header bounds, wrong password,
corrupted tag/header, lost response, 409/collision, exact read-back, unique
names, plaintext historical ZIP и fail-closed для non-envelope `.enc.zip`,
unknown bytes и encrypted legacy names. Реальное создание, download и restore
до/после rotate/disable входят в `SMOKE_TESTS.md` TC-08. Freshness proof Force
проверяется в TC-07 и TC-FORCE-REPLACE-01.
