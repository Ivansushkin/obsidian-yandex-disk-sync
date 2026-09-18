# Конфликты и сохранность локальных данных

## Причинные правила

Локальный drift определяется plaintext SHA-256 относительно baseline. Для remote
используется physical fingerprint, а при его отсутствии — server mtime относительно
baseline. Клиентские часы не выбирают победителя.

| Состояние                                            | Результат                                                                                      |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Разные изменения после общего baseline               | Одна версия сохраняется как conflict copy, canonical winner применяется к исходному пути       |
| Файл без baseline и отличающийся remote того же пути | Локальный файл считается новым; обе версии сохраняются                                         |
| Exact delete против stale edit                       | Delete побеждает; неподтверждённые локальные bytes требуют protective copy                     |
| Causally-later put после delete                      | Путь восстанавливается                                                                         |
| Folder delete против нового/изменённого descendant   | Descendant сохраняется                                                                         |
| Folder move против отличающегося target              | Операция блокируется до mutations; частичный overwrite запрещён                                |
| Последовательные edits одной установки               | Непрерывный mutation watermark предотвращает ложный конфликт                                   |
| Replacement epoch и offline edit                     | Full сравнивает прежний baseline с filesystem и новым canonical; старые actions не replay-ятся |

## Conflict copies

Имя содержит исходное имя, timestamp и suffix установки. При коллизии добавляется
свободный suffix. Имя само по себе не доказывает, что файл можно переиспользовать:
сравниваются его фактические bytes. Отредактированная существующая копия сохраняется,
а проигравшая версия получает другой путь. Новая копия создаётся с условием отсутствия;
конкурентное появление файла не превращает создание в overwrite.

Rejected-put recovery использует те же правила, что обычный conflict flow. Повторный
запуск переиспользует совпадающую копию, не создавая дубль. Restore canonical winner
в исходный путь проходит обычную защищённую процедуру download.

## Download и protective copies

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
