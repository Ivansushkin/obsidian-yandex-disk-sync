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

Ручное создание архива резервирует foreground operation до первого await и выполняется
через maintenance существующего coordinator. Папка, режим и пароль фиксируются до
чтения файлов и создания ZIP; изменение settings не перенаправляет архив. Force и
transition используют собственное владение, без вложенной очереди.

Connection/scope и конкурирующие foreground операции заблокированы до completion.
Список и download привязаны к поколению конфигурации. После смены settings или закрытия
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
При выборе архива Force показывает эти этапы в persistent Notice с момента подтверждения,
удерживая блокировку кнопок до окончания всего сценария.

После success, timeout или 409 клиент выполняет stable raw download. Возможны
только два результата:

- SHA-256 и bytes совпали — операция подтверждена, включая lost response;
- объект отсутствует или bytes отличаются — имя считается collision, создаётся
  новое random имя; существующий объект не перезаписывается.

Перед Force и enable/disable/rotate пользователь выбирает `with-backup`,
`without-backup` или `cancel`. Выбор не сохраняется как настройка. При отказе от
архива операции проходят те же проверки canonical, source snapshot, codec и
fingerprints. Защитные копии отдельных перезаписываемых/удаляемых файлов и
conflict copies остаются обязательными по прежним правилам.

Force выполняет read-only canonical preflight и фиксирует digest защищаемой
стороны: remote-raw для Force local, logical-vault для Force remote. В coordinator
передаётся `ForcePreflightProof` с raw canonical identity, snapshot digest и
`backup: null` либо именем/SHA-256 выбранного архива. Перед первой mutation
canonical и snapshot повторно проверяются; для архива проверяется также raw SHA.
Source проверяется на каждом transfer и ещё раз перед replacement commit.
Старый `ForceBackupProof` адаптируется к варианту с архивом; два proof одновременно
запрещены. Ошибка архива или drift завершает попытку, без fallback и повторного
архива. Следующий запуск снова предлагает выбор.

Canonical proof также фиксирует root locks по именам и stable content fingerprints.
Изменение canonical или locks до replacement commit требует нового preflight;
фактически захваченный canonical сверяется с proof. Старый proof без locks
допустим только при их отсутствии. Root locks включаются в `remote-raw` архив,
но не считаются пользовательской legacy path collision. Force preflight не
запускает normal recovery и не меняет remote до подтверждения.
При ошибке очистки уже подтверждённый replacement сохраняется локально, успех
не объявляется и новый архив автоматически не создаётся. Финальный successful
full дополняется явной проверкой root locks, поэтому ещё не stale orphan не
превращает ошибку cleanup в успешный UI outcome. Encryption readiness до
запуска Force не выполняет implicit transition recovery или reconnect.

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
не создают архив. После подтверждённого replacement commit authoritative новый
epoch; незавершённый cleanup продолжает normal full.

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

При выборе архива encryption transition создаёт один logical backup после
source preflight; Force архивирует только защищаемую сторону. Без архива
полный ZIP не создаётся. Это сохраняет прежний memory peak. Mobile PERF-006 остаётся
обязательным release gate.

## Проверки

Автоматические проверки покрывают envelope auth/header bounds, wrong password,
corrupted tag/header, lost response, 409/collision, exact read-back, unique
names, plaintext historical ZIP и fail-closed для non-envelope `.enc.zip`,
unknown bytes и encrypted legacy names. Реальное создание, download и restore
до/после rotate/disable входят в `SMOKE_TESTS.md` TC-08. Freshness proof Force
проверяется в TC-07.
