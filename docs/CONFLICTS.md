# Конфликты и сохранность локальных данных

## Причинные правила

Локальный drift определяется plaintext SHA-256 относительно baseline. Для remote
используется physical fingerprint, а при его отсутствии — server mtime относительно
baseline. Клиентские часы не выбирают победителя.

| Состояние                                                                           | Результат                                                                                      |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Разные изменения после общего baseline                                              | Одна версия сохраняется как conflict copy, canonical winner применяется к исходному пути       |
| Файл без baseline после завершённого подключения и отличающийся remote того же пути | Локальный файл считается новым; обе версии сохраняются                                         |
| Exact delete против stale edit                                                      | Delete побеждает; неподтверждённые локальные bytes требуют protective copy                     |
| Causally-later put после delete                                                     | Путь восстанавливается                                                                         |
| Folder delete против нового/изменённого descendant                                  | Descendant сохраняется                                                                         |
| Folder move против отличающегося target                                             | Операция блокируется до mutations; частичный overwrite запрещён                                |
| Последовательные edits одной установки                                              | Непрерывный mutation watermark предотвращает ложный конфликт                                   |
| Replacement epoch и offline edit                                                    | Full сравнивает прежний baseline с filesystem и новым canonical; старые actions не replay-ятся |

## Первое подключение устройства

При `lastSyncTime = observedRevision = 0`, первом sequence и отсутствии mutations
full сначала принимает существующий canonical. Разные local bytes сохраняются
в protective copy вне sync scope, затем применяется cloud; одинаковые файлы
с matching physical fingerprint получают baseline без передачи. Exact tombstones
требуют protective copy и guarded local delete; неизвестные local-only файлы
остаются на месте. После проверки snapshot и coherent save обычный full загружает
local-only. Это не Force и не replacement epoch.

Partial baselines переживают restart; до полного получения observed revision/time
не продвигаются и watcher work не публикуется. Legacy baseline с неизвестным epoch,
существующие mutations и encryption recovery продолжают прежние workflows.

## Conflict copies

Новая копия получает детерминированное имя: исходное имя, `_conflict_` и SHA-256
ключа «исходный logical path + NUL + plaintext SHA-256». Время и ID установки
не определяют идентичность копии. При коллизии добавляется свободный suffix.
Накопившиеся timestamp-копии не сканируются, не переименовываются и не очищаются.
Имя само по себе не доказывает, что файл можно переиспользовать:
сравниваются его фактические bytes. Отредактированная существующая копия сохраняется,
а проигравшая версия получает другой путь. Новая копия создаётся с условием отсутствия;
конкурентное появление файла не превращает создание в overwrite. Remote upload
использует exclusive create и stable plaintext read-back, включая 409 и потерянный
ответ. После commit и до применения winner повторно подтверждаются live canonical
и физические plaintext bytes копии: успешный transaction сам по себе не доказывает,
что её put не был отклонён exact tombstone. Потеря reservation останавливает замену.
Corrective upload повторяет canonical/physical/codec guards перед каждой PUT-попыткой,
в том числе после промежуточного copy commit. Повтор
переиспользует bytes и pending mutation, а отредактированный candidate сохраняется.

Rejected-put recovery использует те же правила, что обычный conflict flow. Повторный
запуск переиспользует совпадающую копию, не создавая дубль. Restore canonical winner
в исходный путь проходит обычную защищённую процедуру download.

Перед конфликтом metadata уточняется по содержимому. Серверный SHA ciphertext
не сравнивается с plaintext SHA как логическое содержимое. Matching physical SHA
может подтвердить plaintext SHA canonical; иначе используется stable logical
download. Смена MD5 на SHA-256 или новый IV сами по себе не означают конфликт.
Равные local/remote bytes не требуют копии; если canonical устарел, необходима
причинная mutation, а не фиктивный no-op. Remote `A → X → A` допускает local
`A → B` только при проверке исходного baseline в canonical transaction.

## Подключение и потеря истории

`LocalSyncState.remoteScope` связывает историю с нормализованным remote path и
opaque `resource_id` корневой папки. Это идентичность папки, а не content proof.
Смена токена для той же папки сохраняет baseline. Другая/пересозданная папка не
получает прежние удаления. Неизвестная identity останавливает синхронизацию.

Точная прежняя current local shape получает nullable binding без потери queues.
Первое подключение непустой истории требует явного подтверждения прежнего storage,
выбора нового либо отмены. До подтверждения recovery и sync не пишут remote.
Новый storage допускается только без pending queues и transition; старый baseline
сбрасывается согласованно, пользовательские файлы не удаляются. Failed save
восстанавливает прежний snapshot. Отдельного каталога прошлых хранилищ нет.

Полная потеря plugin data создаёт новую causal identity, независимо от старого ID
в localStorage. Валидные pending IDs не перенумеровываются. Counter сверяется с
watermark текущего epoch; чужие pending IDs и FIFO gaps блокируют операции.
Пустой/недоступный cache ID не заменяет сохранённый actor. При чистом первом sync
наблюдаемый epoch сохраняется до создания durable work, без подтверждения baseline
или продвижения observed revision; crash сохраняет идентичность copy put.
После завершённого первого подключения без baseline разные bytes остаются конфликтом. Local/server mtime
не доказывают, какую из неизвестных версий можно удалить.

Неоднозначный ответ обычного или corrective PUT подтверждается только stable
plaintext read-back с повторными scope/canonical/epoch/codec guards. Это подтверждение
уже отправленного transfer, а не разрешение на повторный overwrite. Окончательные
HTTP ошибки и ошибки preflight не превращаются в успех. Недоступная проверка
оставляет работу незавершённой. При ошибке upload-группы full сохраняет coherent
snapshot и выходит до settlement и последующих файловых операций; pending IDs и
FIFO остаются для restart. Corrective upload сохраняет причинные поля принятой
версии и публикует fingerprint через существующий guarded physical rewrite.

## Download и protective copies

Сетевой обрыв либо HTTP 500/502/503/504 при передаче bytes запускает ограниченный
retry с новой signed link. API GET также повторяет завершённые 500/502/504;
это не расширяет правила неоднозначных PUT.
Исчерпание попыток оставляет download ошибкой без подтверждения baseline.
Каждый GET ограничен 60 s; stable raw/logical snapshot и direct download также
имеют общий бюджет 60 s на metadata, link, bytes и retry/backoff; timeout не повторяет неотменённый native
request и запрещает применять его поздний ответ. Full выходит до последующих
conflict/delete commits; уже начатые downloads завершаются с прежними guards. После
restart неизменённый local файл с прежним baseline получает remote update без
ложного конфликта; независимая local правка по-прежнему требует causal comparison.

До подготовки overwrite проверяется привязка root. После подготовки parent folders,
перед последней проверкой local identity и watcher suppression, raw identity root
проверяется снова; это относится и к созданию conflict copy. Drift либо ошибка
чтения не разрешают локальную запись. Между отдельными HTTP и filesystem operations
атомарной гарантии нет.

До remote I/O фиксируется local absence либо SHA. Проверка повторяется после protective
backup и после подготовки parent folders в VaultAdapter. Late create/edit останавливает
устаревшую запись без подтверждения baseline/download/watcher suppression. Следующий
reconciliation снова применяет причинные правила и сохраняет обе версии.

Существующие неподтверждённые bytes, отличающиеся от download, архивируются отдельно,
включая отсутствие baseline. Ошибка protective copy запрещает overwrite. Для Force
remote разрешена замена подтверждённого snapshot; последующий drift блокирует её.
Выбор without-backup отключает только полный архив.

Local delete подтверждает canonical и SHA после protective backup. Новая правка
откладывает действие; фактическое удаление использует Obsidian FileManager trash.
Remote delete и source cleanup проверяют authority/fingerprint на каждом retry и
подтверждаются отсутствием объекта. Read-before-delete не является атомарной блокировкой
против внешней записи.

## Пути и события

NFC/case-fold collisions родителей, file/directory/ancestor collisions и несовместимые
локальные объекты блокируют применение. Exact update, обычный Unicode и `__proto__`
допустимы. Скрытого переименования или изменения Unicode normalization нет.

Один coordinator и durable watcher queue сохраняют causal order. Internal watcher
события подавляются только для ожидаемых операций. Пауза не означает, что реальные
конкурентные изменения перестают создавать конфликты. Порядок prepare/settle/resume
описан в [PARALLELIZATION.md](PARALLELIZATION.md).

## Диагностика и проверка

Проверять содержимое исходного файла, conflict/protective copy, canonical и очереди;
число вызовов backup само по себе не доказывает сохранность. См. сценарии SYNC, DEL,
FDEL, MOVE и SAFE в [каталоге](SYNC_USER_SCENARIOS.md), TC-04/05/06/09 в
[smoke tests](SMOKE_TESTS.md). Реальный двухпрофильный прогон остаётся отдельной проверкой.

Отклонённый rename использует тот же guarded local delete, что rejected upload.
Спекулятивный local stamp upload не доказывает наличие подтверждённого baseline:
без исходного baseline нужна protective copy. Изменение файла во время неё оставляет
действие pending и rename возвращает retry. Cleanup retargeted source требует live
target; cleanup отклонённого destination требует exact canonical tombstone.

Диагностика conflict classification различает наличие baseline, совпадение local
SHA с baseline/canonical и epoch adoption. Эти признаки не заменяют guards и не
меняют выбор winner. Этапы read/copy/upload/commit/verify/apply логируются без
bytes; read timeout указывает API/transfer и сохраняет код ошибки. Progress
подтверждает завершённые попытки, а не начало conflict flow.
